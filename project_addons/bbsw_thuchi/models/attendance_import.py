import base64
import io
from datetime import datetime, timedelta

import pytz

from odoo import models, fields, api
from odoo.exceptions import UserError

_VN_TZ = pytz.timezone('Asia/Ho_Chi_Minh')

# Mã chấm công → số công (ngày)
ATTENDANCE_CODE_MAP = {
    'X':    1.0,   # Ngày công chính thức
    'TV':   1.0,   # Ngày công thử việc
    'P':    1.0,   # Phép năm (hưởng lương)
    'BH':   1.0,   # Nghỉ chế độ bảo hiểm
    'CĐ':   1.0,   # Nghỉ chế độ (hiếu, hỉ)
    'NL':   1.0,   # Nghỉ lễ, tết
    'CT':   1.0,   # Công tác
    'X/KL': 0.5,   # Nghỉ nửa ngày không lương
    'P/KL': 0.5,   # Nửa ngày phép, nửa ngày không lương
    'X/P':  0.5,   # Nghỉ nửa ngày phép năm
    'X/NB': 0.5,   # Đi làm nửa ngày, nghỉ bù nửa ngày
    'NB':   1.0,   # Nghỉ bù (hưởng 100% lương, tracked riêng ở L10)
    'KL':   0.0,   # Nghỉ không lương
}


class BbswAttendanceImport(models.TransientModel):
    _name = 'bbsw.attendance.import'
    _description = 'Import chấm công từ file'

    file_data = fields.Binary(string='File Excel (.xlsx)', required=True, attachment=False)
    file_name = fields.Char(string='Tên file')
    period_month = fields.Integer(
        string='Tháng', required=True,
        default=lambda self: fields.Date.today().month)
    period_year = fields.Integer(
        string='Năm', required=True,
        default=lambda self: fields.Date.today().year)
    overwrite = fields.Boolean(
        string='Ghi đè dữ liệu cũ',
        help='Xóa toàn bộ chấm công của tháng này trước khi import')
    result_message = fields.Text(string='Kết quả', readonly=True)

    def action_import(self):
        self.ensure_one()
        if not self.file_data:
            raise UserError('Vui lòng chọn file để import.')

        fname = (self.file_name or '').lower()
        raw = base64.b64decode(self.file_data)

        if fname.endswith('.xlsx') or fname.endswith('.xls'):
            result = self._import_excel(raw)
        else:
            raise UserError('Chỉ hỗ trợ file .xlsx. Vui lòng lưu file Excel dưới dạng .xlsx')

        self.result_message = result
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'bbsw.attendance.import',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def _import_excel(self, raw):
        try:
            import openpyxl
        except ImportError:
            raise UserError('Thư viện openpyxl chưa được cài. Chạy: pip install openpyxl')

        wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
        ws = wb.active

        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            raise UserError('File Excel trống.')

        # ── Tìm dòng header chứa "Mã NV" hoặc "Mã nv"
        header_row_idx = None
        for i, row in enumerate(rows):
            row_strs = [str(c).strip().upper() if c else '' for c in row]
            if any('MÃ NV' in s or 'MA NV' in s or 'MANV' in s or 'MÃ NHÂN VIÊN' in s for s in row_strs):
                header_row_idx = i
                break

        if header_row_idx is None:
            raise UserError('Không tìm thấy dòng tiêu đề có "Mã NV". Kiểm tra lại file.')

        header = rows[header_row_idx]

        # ── Xác định cột Mã NV và cột ngày
        col_emp_code = None
        # day_cols: col_index → day_number (chưa xác định tháng)
        day_cols = {}

        for col_i, cell in enumerate(header):
            val = str(cell).strip() if cell is not None else ''
            val_up = val.upper()
            if col_emp_code is None and ('MÃ NV' in val_up or 'MA NV' in val_up or 'MANV' in val_up):
                col_emp_code = col_i
            elif val.isdigit():
                day = int(val)
                if 1 <= day <= 31:
                    day_cols[col_i] = day

        if col_emp_code is None:
            raise UserError('Không tìm thấy cột "Mã NV".')
        if not day_cols:
            raise UserError('Không tìm thấy cột ngày (số nguyên 1-31) trong header.')

        # ── Xử lý tháng giao thoa: ngày > 20 xuất hiện TRƯỚC ngày 1 → thuộc tháng trước
        # Ví dụ: bảng T2/2026 có cột 26,27,28,29,30,31 (Jan) rồi 1,2,...27 (Feb)
        # Bug cũ: datetime(2026, 2, 29/30/31) → ValueError → bị bỏ qua mất ngày công
        prev_month = self.period_month - 1 or 12
        prev_year = self.period_year if self.period_month > 1 else self.period_year - 1

        date_cols_fixed = {}
        found_day1 = False
        for col_i in sorted(day_cols.keys()):
            day = day_cols[col_i]
            if day == 1:
                found_day1 = True
            if not found_day1 and day > 20:
                # Thuộc tháng trước
                try:
                    d = datetime(prev_year, prev_month, day).date()
                    date_cols_fixed[col_i] = d
                except ValueError:
                    pass  # Ngày không hợp lệ ngay cả ở tháng trước → bỏ qua
            else:
                # Thuộc tháng hiện tại
                try:
                    d = datetime(self.period_year, self.period_month, day).date()
                    date_cols_fixed[col_i] = d
                except ValueError:
                    pass  # Ngày không hợp lệ (vd: ngày 29 trong tháng 2 không nhuận)

        # ── Build employee map
        employees = self.env['hr.employee'].search([('employee_code', '!=', False)])
        emp_map = {e.employee_code.strip().upper(): e for e in employees}

        # ── Xóa attendance cũ nếu overwrite
        # Kỳ lương tháng M = 26/(M-1) → 27/M, nên xóa từ 26/(M-1) đến trước 28/M
        if self.overwrite:
            if self.period_month == 1:
                month_start = f'{self.period_year - 1}-12-26'
            else:
                month_start = f'{self.period_year}-{self.period_month - 1:02d}-26'
            month_end = f'{self.period_year}-{self.period_month:02d}-28'
            old = self.env['hr.attendance'].search([
                ('check_in', '>=', month_start),
                ('check_in', '<', month_end),
            ])
            old.unlink()

        created = 0
        skipped = 0
        errors = []
        data_start = header_row_idx + 1
        # Bỏ qua dòng phụ (T2, T3, CN...) ngay sau header nếu có
        if data_start < len(rows):
            first_data = rows[data_start]
            emp_val = str(first_data[col_emp_code]).strip().upper() if first_data[col_emp_code] else ''
            if emp_val in ('T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN', 'NONE', ''):
                data_start += 1

        for row_i in range(data_start, len(rows)):
            row = rows[row_i]
            if not row or all(c is None for c in row):
                continue

            emp_code_val = str(row[col_emp_code]).strip().upper() if row[col_emp_code] else ''
            if not emp_code_val or emp_code_val in ('NONE', ''):
                continue
            # Dừng nếu gặp dòng tổng kết
            if any(s in emp_code_val for s in ('TỔNG', 'TOTAL', 'CỘNG')):
                break

            employee = emp_map.get(emp_code_val)
            if not employee:
                errors.append(f'Dòng {row_i + 1}: Không tìm thấy nhân viên mã "{emp_code_val}"')
                continue

            for col_i, date_val in date_cols_fixed.items():
                cell = row[col_i] if col_i < len(row) else None
                code = str(cell).strip().upper() if cell else ''
                if not code or code == 'NONE':
                    skipped += 1
                    continue

                work_days = ATTENDANCE_CODE_MAP.get(code)
                if work_days is None:
                    # Thử số thập phân trực tiếp
                    try:
                        work_days = float(code.replace(',', '.'))
                    except ValueError:
                        errors.append(f'Dòng {row_i+1}, ngày {date_val}: Mã "{code}" không xác định')
                        continue

                if work_days <= 0:
                    skipped += 1
                    continue

                work_hours = work_days * 9.0  # 9:00 → 18:00 = 9 giờ/ngày
                # Convert giờ local VN (UTC+7) → UTC để Odoo hiển thị đúng
                local_in = _VN_TZ.localize(
                    datetime(date_val.year, date_val.month, date_val.day, 9, 0, 0))
                check_in = local_in.astimezone(pytz.utc).replace(tzinfo=None)
                check_out = check_in + timedelta(hours=work_hours)

                self.env['hr.attendance'].create({
                    'employee_id': employee.id,
                    'check_in': check_in,
                    'check_out': check_out,
                    'attendance_code': code,
                })
                created += 1

        parts = [f'✅ Import thành công: {created} bản ghi chấm công']
        if skipped:
            parts.append(f'⏭ Bỏ qua: {skipped} ô trống/nghỉ không công')
        if errors:
            parts.append(f'\n⚠ Cảnh báo {len(errors)} dòng:')
            parts.extend(errors[:15])
            if len(errors) > 15:
                parts.append(f'... và {len(errors) - 15} lỗi khác')
        return '\n'.join(parts)
