/* ═══════════════════════════════════════════════
   BBSW Thu Chi Page — Main JS
   ═══════════════════════════════════════════════ */
(function () {
    'use strict';

    const D = window.BBSW || {};

    let currentMonth   = D.currentMonth || new Date().toISOString().slice(0, 7);
    let currentType    = 'all';
    let currentRecords = [];
    let deleteRecordId = null;
    let searchTimeout  = null;

    const fmt = (n) => new Intl.NumberFormat('vi-VN', {
        style: 'currency', currency: 'VND', maximumFractionDigits: 0,
    }).format(n);

    function esc(str) {
        return String(str || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function callApi(route, params) {
        const res = await fetch(route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: Date.now(), params: params || {} }),
        });
        const data = await res.json();
        if (data.error) {
            throw new Error((data.error.data && data.error.data.message) || data.error.message || 'Lỗi không xác định');
        }
        return data.result;
    }

    function showToast(msg, type) {
        const el = document.getElementById('toast');
        if (!el) return;
        el.textContent = msg;
        el.className = 'tc-toast tc-toast-' + (type || 'success') + ' show';
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.classList.remove('show'), 3000);
    }

    // ── Month picker ──────────────────────────────────────────────
    function initMonthPicker() {
        const btn = document.getElementById('monthBtn');
        const label = document.getElementById('monthLabel');
        const dropdown = document.getElementById('monthDropdown');
        if (!btn || !dropdown) return;

        const MONTHS = ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6',
                        'Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'];

        function renderLabel(month) {
            const p = month.split('-');
            label.textContent = MONTHS[parseInt(p[1]) - 1] + '/' + p[0];
        }
        function buildDropdown() {
            const today = new Date();
            let html = '';
            for (let i = 5; i >= 0; i--) {
                const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
                const val = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
                html += '<button class="tc-month-opt' + (val === currentMonth ? ' active' : '') + '" data-val="' + val + '">T' + (d.getMonth() + 1) + '/' + d.getFullYear() + '</button>';
            }
            dropdown.innerHTML = html;
        }
        renderLabel(currentMonth);
        buildDropdown();
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const open = dropdown.classList.toggle('open');
            btn.classList.toggle('open', open);
        });
        dropdown.addEventListener('click', function (e) {
            const opt = e.target.closest('.tc-month-opt');
            if (!opt) return;
            currentMonth = opt.dataset.val;
            renderLabel(currentMonth);
            buildDropdown();
            dropdown.classList.remove('open');
            btn.classList.remove('open');
            loadRecords();
        });
        document.addEventListener('click', function () {
            dropdown.classList.remove('open');
            btn.classList.remove('open');
        });
    }

    function initTabs() {
        const tabs = document.getElementById('typeTabs');
        if (!tabs) return;
        tabs.addEventListener('click', function (e) {
            const tab = e.target.closest('.tc-tab');
            if (!tab) return;
            tabs.querySelectorAll('.tc-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentType = tab.dataset.type;
            loadRecords();
        });
    }

    function initSearch() {
        const input = document.getElementById('searchInput');
        if (!input) return;
        input.addEventListener('input', function () {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(loadRecords, 350);
        });
    }

    async function loadRecords() {
        const loading = document.getElementById('loadingState');
        const empty   = document.getElementById('emptyState');
        const table   = document.getElementById('recordsTable');
        if (loading) loading.style.display = 'flex';
        if (empty)   empty.style.display   = 'none';
        if (table)   table.style.display   = 'none';
        try {
            const search = (document.getElementById('searchInput') || {}).value || '';
            const result = await callApi('/project/thuchi/api/records', {
                month: currentMonth, type_filter: currentType, search: search,
            });
            currentRecords = result.records;
            updateStats(result);
            if (loading) loading.style.display = 'none';
            if (!result.records.length) {
                if (empty) empty.style.display = 'flex';
            } else {
                if (table) { table.style.display = 'block'; renderRows(result.records); }
            }
        } catch (err) {
            if (loading) loading.style.display = 'none';
            showToast('Lỗi tải dữ liệu: ' + err.message, 'error');
        }
    }

    function updateStats(result) {
        const elThu = document.getElementById('statThu');
        const elChi = document.getElementById('statChi');
        const elBal = document.getElementById('statBalance');
        const card  = document.getElementById('balanceCard');
        if (elThu) elThu.textContent = fmt(result.thu_total);
        if (elChi) elChi.textContent = fmt(result.chi_total);
        if (elBal) {
            const pos = result.balance >= 0;
            elBal.textContent = (pos ? '+' : '') + fmt(result.balance);
            elBal.className = 'tc-stat-value ' + (pos ? 'tc-balance-pos' : 'tc-balance-neg');
        }
        if (card) card.classList.toggle('tc-stat-negative', result.balance < 0);
    }

    const STATE_META = {
        draft:     { label: 'Nháp',      cls: 'badge-draft'     },
        pending:   { label: 'Chờ duyệt', cls: 'badge-pending'   },
        approved:  { label: 'Đã duyệt',  cls: 'badge-confirmed' },
        rejected:  { label: 'Từ chối',   cls: 'badge-cancelled' },
        cancelled: { label: 'Đã hủy',    cls: 'badge-cancelled' },
        confirmed: { label: 'Xác nhận',  cls: 'badge-confirmed' },
    };
    const TYPE_META = {
        thu:      { label: 'Thu',      cls: 'type-thu'  },
        chi:      { label: 'Chi',      cls: 'type-chi'  },
        vay:      { label: 'Vay',      cls: 'type-vay'  },
        hoan_ung: { label: 'Hoàn ứng', cls: 'type-hoan' },
    };
    const PAY_META = {
        paid:   { label: 'Đã TT',   cls: 'badge-confirmed' },
        unpaid: { label: 'Chưa TT', cls: 'badge-draft'     },
    };

    function renderRows(records) {
        const tbody = document.getElementById('recordsTbody');
        if (!tbody) return;
        tbody.innerHTML = records.map(function (r) {
            const sm = STATE_META[r.state]        || { label: r.state,          cls: '' };
            const tm = TYPE_META[r.type]          || { label: r.type,           cls: '' };
            const pm = PAY_META[r.payment_status] || { label: r.payment_status, cls: '' };
            const pos = r.type === 'thu';
            return '<tr data-id="' + r.id + '">'
                + '<td class="tc-code">' + esc(r.transaction_code) + '</td>'
                + '<td class="tc-date">' + esc(r.date) + '</td>'
                + '<td class="tc-desc">'
                +   '<span class="tc-desc-text" title="' + esc(r.name) + '">' + esc(r.name) + '</span>'
                +   (r.is_advance ? '<span class="tc-advance-badge">TU</span>' : '')
                +   (r.user_name ? '<span class="tc-user">' + esc(r.user_name) + '</span>' : '')
                + '</td>'
                + '<td><span class="tc-type-badge ' + tm.cls + '">' + tm.label + '</span></td>'
                + '<td><span class="tc-cat-badge">' + esc(r.category_name) + '</span></td>'
                + '<td class="tc-nowrap">' + esc(r.business_unit_name) + '</td>'
                + '<td class="tc-nowrap">' + esc(r.project_name) + '</td>'
                + '<td class="tc-nowrap">' + esc(r.object_name) + '</td>'
                + '<td class="tc-nowrap">' + esc(r.payment_method_name) + '</td>'
                + '<td class="text-end"><span class="tc-amount ' + (pos ? 'amt-thu' : 'amt-chi') + '">'
                +   (pos ? '+' : '−') + fmt(r.amount) + '</span></td>'
                + '<td><span class="tc-state-badge ' + pm.cls + '">' + pm.label + '</span></td>'
                + '<td><span class="tc-state-badge ' + sm.cls + '">' + sm.label + '</span>'
                +   (r.state === 'rejected' && r.rejection_reason ? '<span class="tc-reject-reason" title="' + esc(r.rejection_reason) + '"> ℹ</span>' : '')
                + '</td>'
                + '<td class="tc-attach-cell">'
                +   '<button class="tc-attach-btn" data-action="attach" data-id="' + r.id + '" title="Chứng từ" type="button">'
                +     '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/></svg>'
                +     (r.attachment_count ? '<span class="tc-attach-count">' + r.attachment_count + '</span>' : '')
                +   '</button>'
                + '</td>'
                + '<td class="tc-actions">' + buildActionBtns(r) + '</td>'
                + '</tr>';
        }).join('');
        tbody.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', handleRowAction));
    }

    const ICON = {
        submit:  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>',
        approve: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>',
        cancel:  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>',
        draft:   '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>',
        view:    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>',
        edit:    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>',
        delete:  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>',
    };

    function mkBtn(action, cls, title, id, name) {
        return '<button class="tc-row-btn ' + cls + '" data-action="' + action
             + '" data-id="' + id + '" data-name="' + esc(name) + '" title="' + title
             + '" type="button">' + ICON[action] + '</button>';
    }

    function buildActionBtns(r) {
        const { id, name, state } = r;
        let html = '';
        // Workflow buttons
        if (state === 'draft')                             html += mkBtn('submit',  'tc-row-confirm', 'Gửi duyệt', id, name);
        if (state === 'pending')                           html += mkBtn('approve', 'tc-row-confirm', 'Duyệt',     id, name);
        if (state === 'pending' || state === 'approved')   html += mkBtn('cancel',  'tc-row-cancel',  'Hủy',       id, name);
        if (state === 'rejected' || state === 'cancelled') html += mkBtn('draft',   'tc-row-draft',   'Về nháp',   id, name);
        // Divider
        html += '<span class="tc-action-sep"></span>';
        // CRUD buttons — always visible
        html += mkBtn('view',   'tc-row-view',   'Xem chi tiết', id, name);
        html += mkBtn('edit',   'tc-row-edit',   'Chỉnh sửa',    id, name);
        html += mkBtn('delete', 'tc-row-delete', 'Xóa',          id, name);
        return html;
    }

    async function handleRowAction(e) {
        const btn    = e.currentTarget;
        const action = btn.dataset.action;
        const id     = parseInt(btn.dataset.id);
        if (action === 'attach') { openAttachModal(id); return; }
        if (action === 'view')   { openViewModal(id); return; }
        if (action === 'edit')   { openEditModal(id); return; }
        if (action === 'delete') {
            deleteRecordId = id;
            const nameEl = document.getElementById('deleteRecordName');
            if (nameEl) nameEl.textContent = '"' + btn.dataset.name + '"';
            openBackdrop('deleteBackdrop');
            return;
        }
        btn.disabled = true;
        try {
            await callApi('/project/thuchi/api/action', { record_id: id, action: action });
            showToast({ submit: 'Đã gửi duyệt', approve: 'Đã duyệt ✓', cancel: 'Đã hủy', draft: 'Đã về nháp' }[action] || 'Thành công');
            loadRecords();
        } catch (err) {
            showToast(err.message, 'error');
            btn.disabled = false;
        }
    }

    function openBackdrop(id)  { const el = document.getElementById(id); if (el) { el.classList.add('open'); document.body.style.overflow = 'hidden'; } }
    function closeBackdrop(id) { const el = document.getElementById(id); if (el) { el.classList.remove('open'); document.body.style.overflow = ''; } }

    function populateSelect(selId, items, valueProp, labelProp) {
        const sel = document.getElementById(selId);
        if (!sel) return;
        const first = sel.options[0];
        sel.innerHTML = '';
        sel.appendChild(first);
        (items || []).forEach(function (item) {
            const opt = document.createElement('option');
            opt.value = item[valueProp];
            opt.textContent = item[labelProp];
            sel.appendChild(opt);
        });
    }

    function initSelectData() {
        populateSelect('fBusinessUnit',  D.businessUnits  || [], 'id', 'name');
        populateSelect('fProject',       D.projects       || [], 'id', 'name');
        populateSelect('fPaymentMethod', D.paymentMethods || [], 'id', 'name');
        populateSelect('fPartner',       D.partners       || [], 'id', 'name');
        populateSelect('fEmployee',      D.employees      || [], 'id', 'name');
    }

    const CATS_BY_TYPE = {
        thu:      () => D.categoriesThu      || [],
        chi:      () => D.categoriesChi      || [],
        vay:      () => D.categoriesVay      || [],
        hoan_ung: () => D.categoriesHoanUng  || [],
    };

    function updateCategoryOptions(type, selectedId) {
        const cats = (CATS_BY_TYPE[type] || (() => []))();
        const sel = document.getElementById('fCategory');
        if (!sel) return;
        sel.innerHTML = '<option value="">-- Chọn danh mục --</option>'
            + cats.map(c => '<option value="' + c.id + '"' + (String(c.id) === String(selectedId || '') ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
    }

    function showObjectField(type) {
        ['fPartnerWrap','fEmployeeWrap','fStudentWrap','fOtherWrap'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });
        const map = { partner: 'fPartnerWrap', employee: 'fEmployeeWrap', student: 'fStudentWrap', other: 'fOtherWrap' };
        const el = document.getElementById(map[type]); if (el) el.style.display = '';
    }

    function getActiveType() {
        const el = document.querySelector('.tc-type-opt.active');
        return el ? el.dataset.val : 'chi';
    }

    function resetModal() {
        ['fName','fNote','fStudentName','fOtherName'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        document.getElementById('fAmount').value = '';
        document.getElementById('fPaymentStatus').value  = 'unpaid';
        document.getElementById('fBusinessUnit').value   = '';
        document.getElementById('fProject').value        = '';
        document.getElementById('fPaymentMethod').value  = '';
        document.getElementById('fObjectType').value     = 'partner';
        document.getElementById('fPartner').value        = '';
        document.getElementById('fEmployee').value       = '';
        showObjectField('partner');
        modalPendingFiles = [];
        renderModalAttachList([]);
        const inp = document.getElementById('modalAttachInput');
        if (inp) inp.value = '';
    }

    function openCreateModal() {
        document.getElementById('editRecordId').value = '';
        document.getElementById('modalTitle').textContent = 'Tạo giao dịch mới';
        resetModal();
        const t = new Date();
        document.getElementById('fDate').value = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
        const type = currentType === 'all' ? 'chi' : currentType;
        document.querySelectorAll('.tc-type-opt').forEach(o => o.classList.toggle('active', o.dataset.val === type));
        updateCategoryOptions(type);
        openBackdrop('modalBackdrop');
        setTimeout(() => { const a = document.getElementById('fAmount'); if (a) a.focus(); }, 120);
    }

    function openEditModal(id) {
        const rec = currentRecords.find(r => r.id === id);
        if (!rec) { showToast('Không tìm thấy bản ghi', 'error'); return; }
        document.getElementById('editRecordId').value = rec.id;
        document.getElementById('modalTitle').textContent = 'Chỉnh sửa giao dịch';
        document.getElementById('fName').value    = rec.name;
        document.getElementById('fAmount').value  = rec.amount;
        document.getElementById('fDate').value    = rec.date_raw;
        document.getElementById('fNote').value    = rec.note || '';
        document.getElementById('fPaymentStatus').value  = rec.payment_status || 'unpaid';
        document.getElementById('fBusinessUnit').value   = rec.business_unit_id || '';
        document.getElementById('fProject').value        = rec.project_id || '';
        document.getElementById('fPaymentMethod').value  = rec.payment_method_id || '';
        const ot = rec.object_type || 'partner';
        document.getElementById('fObjectType').value = ot;
        showObjectField(ot);
        if (ot === 'partner')  document.getElementById('fPartner').value  = rec.partner_id  || '';
        if (ot === 'employee') document.getElementById('fEmployee').value = rec.employee_id || '';
        if (ot === 'student')  { const el = document.getElementById('fStudentName'); if (el) el.value = rec.student_name || ''; }
        if (ot === 'other')    { const el = document.getElementById('fOtherName');   if (el) el.value = rec.other_name   || ''; }
        document.querySelectorAll('.tc-type-opt').forEach(o => o.classList.toggle('active', o.dataset.val === rec.type));
        updateCategoryOptions(rec.type, rec.category_id);
        modalPendingFiles = [];
        renderModalAttachList([]);
        callApi('/project/thuchi/api/attachments', { record_id: rec.id }).then(function (res) {
            renderModalAttachList(res.attachments || []);
        }).catch(function () {});
        openBackdrop('modalBackdrop');
    }

    async function saveRecord(autoConfirm) {
        const name        = (document.getElementById('fName').value || '').trim();
        const amount      = parseFloat(document.getElementById('fAmount').value || '0');
        const category_id = document.getElementById('fCategory').value;
        const date        = document.getElementById('fDate').value;
        const note        = document.getElementById('fNote').value || '';
        const type        = getActiveType();
        const record_id   = document.getElementById('editRecordId').value || null;
        const object_type = document.getElementById('fObjectType').value || 'partner';

        if (!name)              { showToast('Vui lòng nhập mô tả', 'error');     document.getElementById('fName').focus();     return; }
        if (!amount || amount <= 0) { showToast('Số tiền phải > 0', 'error');    document.getElementById('fAmount').focus();   return; }
        if (!category_id)       { showToast('Vui lòng chọn danh mục', 'error'); document.getElementById('fCategory').focus(); return; }
        if (!date)              { showToast('Vui lòng chọn ngày', 'error');      return; }

        const g = id => { const el = document.getElementById(id); return el ? el.value : ''; };

        const params = {
            record_id, name, type, category_id, amount, date, note, auto_confirm: autoConfirm,
            business_unit_id:  g('fBusinessUnit')     || null,
            project_id:        g('fProject')         || null,
            object_type,
            partner_id:        object_type === 'partner'  ? (g('fPartner')     || null) : null,
            employee_id:       object_type === 'employee' ? (g('fEmployee')    || null) : null,
            student_name:      object_type === 'student'  ? g('fStudentName')          : '',
            other_name:        object_type === 'other'    ? g('fOtherName')            : '',
            payment_method_id: g('fPaymentMethod')   || null,
            payment_status:    g('fPaymentStatus')   || 'unpaid',
        };

        const btnId  = autoConfirm ? 'saveConfirm' : 'saveDraft';
        const saveBtn = document.getElementById(btnId);
        const orig = saveBtn.textContent;
        saveBtn.disabled = true; saveBtn.textContent = 'Đang lưu...';

        try {
            const result = await callApi('/project/thuchi/api/save', params);
            if (modalPendingFiles.length) {
                await uploadPendingFiles(result.id);
            }
            showToast(record_id ? 'Đã cập nhật giao dịch' : (autoConfirm ? 'Đã tạo và gửi duyệt ✓' : 'Đã lưu nháp'));
            closeBackdrop('modalBackdrop');
            loadRecords();
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            saveBtn.disabled = false; saveBtn.textContent = orig;
        }
    }

    async function doDelete() {
        if (!deleteRecordId) return;
        const btn = document.getElementById('confirmDelete');
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = 'Đang xóa...';
        try {
            await callApi('/project/thuchi/api/delete', { record_id: deleteRecordId });
            showToast('Đã xóa giao dịch');
            closeBackdrop('deleteBackdrop');
            loadRecords();
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btn.disabled = false; btn.textContent = orig; deleteRecordId = null;
        }
    }

    function initModal() {
        const toggle = document.getElementById('typeToggle');
        if (toggle) {
            toggle.addEventListener('click', function (e) {
                const opt = e.target.closest('.tc-type-opt');
                if (!opt) return;
                document.querySelectorAll('.tc-type-opt').forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                updateCategoryOptions(opt.dataset.val);
            });
        }
        const objType = document.getElementById('fObjectType');
        if (objType) objType.addEventListener('change', function () { showObjectField(this.value); });

        ['openCreateModal','openCreateModal2'].forEach(id => {
            const el = document.getElementById(id); if (el) el.addEventListener('click', openCreateModal);
        });
        ['closeModal','cancelModal'].forEach(id => {
            const el = document.getElementById(id); if (el) el.addEventListener('click', () => closeBackdrop('modalBackdrop'));
        });
        const mb = document.getElementById('modalBackdrop');
        if (mb) mb.addEventListener('click', e => { if (e.target === mb) closeBackdrop('modalBackdrop'); });

        const sd = document.getElementById('saveDraft');
        const sc = document.getElementById('saveConfirm');
        if (sd) sd.addEventListener('click', () => saveRecord(false));
        if (sc) sc.addEventListener('click', () => saveRecord(true));

        ['closeDeleteModal','cancelDelete'].forEach(id => {
            const el = document.getElementById(id); if (el) el.addEventListener('click', () => closeBackdrop('deleteBackdrop'));
        });
        const db = document.getElementById('deleteBackdrop');
        if (db) db.addEventListener('click', e => { if (e.target === db) closeBackdrop('deleteBackdrop'); });
        const cd = document.getElementById('confirmDelete');
        if (cd) cd.addEventListener('click', doDelete);

        const modalFileInput = document.getElementById('modalAttachInput');
        if (modalFileInput) {
            modalFileInput.addEventListener('change', async function () {
                const recId = document.getElementById('editRecordId').value;
                const newFiles = Array.from(this.files);
                if (!newFiles.length) return;
                if (recId) {
                    // editing existing record — upload immediately
                    const progress = document.getElementById('modalAttachProgress');
                    if (progress) progress.style.display = 'block';
                    try {
                        for (const file of newFiles) {
                            const reader = new FileReader();
                            await new Promise(function (resolve, reject) {
                                reader.onload = async function (ev) {
                                    try {
                                        const b64 = ev.target.result.split(',')[1];
                                        await callApi('/project/thuchi/api/attachment/upload', {
                                            record_id: parseInt(recId),
                                            filename: file.name,
                                            mimetype: file.type || 'application/octet-stream',
                                            data: b64,
                                        });
                                        resolve();
                                    } catch (e) { reject(e); }
                                };
                                reader.onerror = reject;
                                reader.readAsDataURL(file);
                            });
                        }
                        const res = await callApi('/project/thuchi/api/attachments', { record_id: parseInt(recId) });
                        renderModalAttachList(res.attachments || []);
                    } catch (err) {
                        showToast(err.message, 'error');
                    } finally {
                        if (progress) progress.style.display = 'none';
                        this.value = '';
                    }
                } else {
                    // new record — queue files
                    modalPendingFiles = modalPendingFiles.concat(newFiles);
                    renderModalAttachList([]);
                    this.value = '';
                }
            });
        }

        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            closeBackdrop('modalBackdrop');
            closeBackdrop('deleteBackdrop');
        });
    }

    // ── View modal ───────────────────────────────────────────────
    let viewRecordId = null;

    function openViewModal(id) {
        const r = currentRecords.find(rec => rec.id === id);
        if (!r) { showToast('Không tìm thấy bản ghi', 'error'); return; }
        viewRecordId = id;
        const sm = STATE_META[r.state]        || { label: r.state,          cls: '' };
        const tm = TYPE_META[r.type]          || { label: r.type,           cls: '' };
        const pm = PAY_META[r.payment_status] || { label: r.payment_status, cls: '' };
        const rows = [
            ['Mã giao dịch',   r.transaction_code],
            ['Ngày',           r.date],
            ['Mô tả',          r.name],
            ['Loại',           '<span class="tc-type-badge ' + tm.cls + '">' + tm.label + '</span>'],
            ['Danh mục',       r.category_name],
            ['Đơn vị',         r.business_unit_name],
            ['Dự án',          r.project_name],
            ['Số tiền',        fmt(r.amount)],
            ['PTTT',           r.payment_method_name],
            ['TT Thanh toán',  '<span class="tc-state-badge ' + pm.cls + '">' + pm.label + '</span>'],
            ['Trạng thái',     '<span class="tc-state-badge ' + sm.cls + '">' + sm.label + '</span>'],
            ['Đối tượng',      r.object_name],
            ['Người tạo',      r.user_name],
        ].filter(([, v]) => v && v !== '0');

        const html = '<dl class="tc-view-dl">'
            + rows.map(([k, v]) => '<div class="tc-view-row"><dt>' + esc(k) + '</dt><dd>' + (/</.test(v) ? v : esc(v)) + '</dd></div>').join('')
            + '</dl>';
        document.getElementById('viewModalBody').innerHTML = html;
        document.getElementById('viewModalTitle').textContent = r.transaction_code + ' — ' + r.name;
        // show/hide edit button based on state
        const editBtn = document.getElementById('viewToEditBtn');
        if (editBtn) editBtn.style.display = (r.state === 'draft') ? '' : 'none';
        openBackdrop('viewBackdrop');
    }

    function initViewModal() {
        ['closeViewModal', 'closeViewModalBtn'].forEach(function (elId) {
            const el = document.getElementById(elId);
            if (el) el.addEventListener('click', function () { closeBackdrop('viewBackdrop'); });
        });
        const vb = document.getElementById('viewBackdrop');
        if (vb) vb.addEventListener('click', function (e) { if (e.target === vb) closeBackdrop('viewBackdrop'); });
        const editBtn = document.getElementById('viewToEditBtn');
        if (editBtn) editBtn.addEventListener('click', function () {
            closeBackdrop('viewBackdrop');
            if (viewRecordId) openEditModal(viewRecordId);
        });
    }

    // ── Attachments ──────────────────────────────────────────────
    let attachRecordId = null;
    let modalPendingFiles = [];

    function renderModalAttachList(items) {
        const el = document.getElementById('modalAttachList');
        if (!el) return;
        const existingHtml = (items || []).map(function (a) {
            return '<div class="tc-attach-item">'
                + '<a href="/web/content/' + a.id + '?download=true" target="_blank" class="tc-attach-name">'
                +   '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>'
                +   esc(a.name)
                + '</a>'
                + '<button class="tc-attach-del" data-attid="' + a.id + '" title="Xóa" type="button">✕</button>'
                + '</div>';
        }).join('');
        const pendingHtml = modalPendingFiles.map(function (f, i) {
            return '<div class="tc-attach-pending-item">'
                + '<span class="tc-attach-name">'
                +   '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>'
                +   esc(f.name)
                + '</span>'
                + '<button class="tc-attach-del" data-pidx="' + i + '" title="Xóa" type="button">✕</button>'
                + '</div>';
        }).join('');
        el.innerHTML = existingHtml + pendingHtml;
        el.querySelectorAll('.tc-attach-del').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                const attid = btn.dataset.attid;
                const pidx  = btn.dataset.pidx;
                if (attid) {
                    btn.disabled = true;
                    try {
                        const recId = document.getElementById('editRecordId').value;
                        await callApi('/project/thuchi/api/attachment/delete', { attachment_id: parseInt(attid) });
                        const res = await callApi('/project/thuchi/api/attachments', { record_id: parseInt(recId) });
                        renderModalAttachList(res.attachments || []);
                    } catch (err) { showToast(err.message, 'error'); btn.disabled = false; }
                } else if (pidx !== undefined) {
                    modalPendingFiles.splice(parseInt(pidx), 1);
                    renderModalAttachList([]);
                }
            });
        });
    }

    async function uploadPendingFiles(recordId) {
        if (!modalPendingFiles.length) return;
        const progress = document.getElementById('modalAttachProgress');
        if (progress) progress.style.display = 'block';
        try {
            for (const file of modalPendingFiles) {
                const reader = new FileReader();
                await new Promise(function (resolve, reject) {
                    reader.onload = async function (ev) {
                        try {
                            const b64 = ev.target.result.split(',')[1];
                            await callApi('/project/thuchi/api/attachment/upload', {
                                record_id: recordId,
                                filename: file.name,
                                mimetype: file.type || 'application/octet-stream',
                                data: b64,
                            });
                            resolve();
                        } catch (e) { reject(e); }
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
            }
        } finally {
            if (progress) progress.style.display = 'none';
            modalPendingFiles = [];
        }
    }

    function renderAttachList(items) {
        const el = document.getElementById('attachList');
        if (!el) return;
        if (!items || !items.length) {
            el.innerHTML = '<p class="tc-attach-empty">Chưa có chứng từ nào</p>';
            return;
        }
        el.innerHTML = items.map(function (a) {
            return '<div class="tc-attach-item">'
                + '<a href="/web/content/' + a.id + '?download=true" target="_blank" class="tc-attach-name">'
                +   '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>'
                +   esc(a.name)
                + '</a>'
                + '<button class="tc-attach-del" data-attid="' + a.id + '" title="Xóa" type="button">✕</button>'
                + '</div>';
        }).join('');
        el.querySelectorAll('.tc-attach-del').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                btn.disabled = true;
                try {
                    await callApi('/project/thuchi/api/attachment/delete', { attachment_id: parseInt(btn.dataset.attid) });
                    await loadAttachments(attachRecordId);
                    loadRecords();
                } catch (err) { showToast(err.message, 'error'); btn.disabled = false; }
            });
        });
    }

    async function loadAttachments(recordId) {
        try {
            const result = await callApi('/project/thuchi/api/attachments', { record_id: recordId });
            renderAttachList(result.attachments || []);
        } catch (err) { showToast(err.message, 'error'); }
    }

    function openAttachModal(id) {
        attachRecordId = id;
        document.getElementById('attachRecordId').value = id;
        document.getElementById('attachList').innerHTML = '<p class="tc-attach-empty">Đang tải...</p>';
        openBackdrop('attachBackdrop');
        loadAttachments(id);
    }

    function initAttachModal() {
        ['closeAttachModal','closeAttachModalBtn'].forEach(function (elId) {
            const el = document.getElementById(elId);
            if (el) el.addEventListener('click', function () { closeBackdrop('attachBackdrop'); });
        });
        const ab = document.getElementById('attachBackdrop');
        if (ab) ab.addEventListener('click', function (e) { if (e.target === ab) closeBackdrop('attachBackdrop'); });

        const fileInput = document.getElementById('attachFileInput');
        if (fileInput) {
            fileInput.addEventListener('change', async function () {
                const files = Array.from(this.files);
                if (!files.length || !attachRecordId) return;
                const progress = document.getElementById('attachUploadProgress');
                if (progress) progress.style.display = 'block';
                try {
                    for (const file of files) {
                        const reader = new FileReader();
                        await new Promise(function (resolve, reject) {
                            reader.onload = async function (ev) {
                                try {
                                    const b64 = ev.target.result.split(',')[1];
                                    await callApi('/project/thuchi/api/attachment/upload', {
                                        record_id: attachRecordId,
                                        filename: file.name,
                                        mimetype: file.type || 'application/octet-stream',
                                        data: b64,
                                    });
                                    resolve();
                                } catch (e) { reject(e); }
                            };
                            reader.onerror = reject;
                            reader.readAsDataURL(file);
                        });
                    }
                    showToast('Đã tải lên ' + files.length + ' chứng từ');
                    await loadAttachments(attachRecordId);
                    loadRecords();
                } catch (err) {
                    showToast(err.message, 'error');
                } finally {
                    if (progress) progress.style.display = 'none';
                    fileInput.value = '';
                }
            });
        }
    }

    document.addEventListener('DOMContentLoaded', function () {
        initSelectData();
        initMonthPicker();
        initTabs();
        initSearch();
        initModal();
        initViewModal();
        initAttachModal();
        loadRecords();
    });

})();
