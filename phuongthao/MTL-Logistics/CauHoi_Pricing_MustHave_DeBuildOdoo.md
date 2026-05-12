# Câu hỏi Pricing cần thiết nhất để build Odoo

Mục tiêu: lọc ra các câu hỏi bắt buộc phải có câu trả lời để thiết kế Odoo cho Pricing, Quotation, Rate Management và luồng bàn giao sang CS/Operation.

## 1. Phạm vi Pricing phụ trách

1. Pricing phụ trách những dịch vụ nào: Sea FCL, Sea LCL, Air, Trucking, Customs, local charge, service charge, commission?
2. Pricing chỉ check buying cost hay có đề xuất/tạo selling price cho khách?
3. Pricing phản hồi giá cho Sales/BD hay gửi trực tiếp cho khách hàng?
4. Ai là người duyệt cuối cùng khi giá đặc biệt, margin thấp hoặc profit âm?

Vì sao cần cho Odoo:
- Xác định module/screen nào Pricing dùng.
- Xác định charge type cần cấu hình.
- Xác định người nhập buying/selling và workflow approval.

## 2. Request check giá từ BD/Sales

1. Pricing nhận yêu cầu check giá từ đâu: CRM Opportunity, email, Zalo, Excel, CS hay khách hàng trực tiếp?
2. Những thông tin tối thiểu nào bắt buộc phải có để Pricing bắt đầu check giá?
3. Nếu thiếu thông tin thì hệ thống cần xử lý thế nào: không cho gửi request, cho gửi nhưng trạng thái `Need More Info`, hay Pricing trả lại Sales/BD?
4. Một request có thể gồm nhiều tuyến, nhiều dịch vụ hoặc nhiều container type không?
5. Có cần quản lý version khi Sales/BD sửa thông tin hoặc khách yêu cầu báo giá lại không?

Vì sao cần cho Odoo:
- Thiết kế form request từ CRM sang Pricing.
- Xác định required fields.
- Thiết kế trạng thái request và revise flow.

## 3. Direction và Service Type

1. Yêu cầu check giá phải tách theo Export/Import như thế nào?
2. Service type cần chuẩn hóa gồm những loại nào: FCL, LCL, Air, Trucking, Customs, Trucking & Customs?
3. Với từng service type, các field bắt buộc khác nhau thế nào?
4. Một quotation có thể gồm nhiều service cùng lúc không, ví dụ Freight + Trucking + Customs?

Vì sao cần cho Odoo:
- Thiết kế dynamic form theo Import/Export và service type.
- Quyết định tab/section nào hiện trên Quotation.
- Tránh màn hình chung quá nhiều field thừa.

## 4. Dữ liệu đầu vào bắt buộc theo từng loại dịch vụ

1. Với FCL cần những field nào: POL, POD, container type, số container, commodity, gross weight, ETD, incoterm, free time?
2. Với LCL cần những field nào: POL, POD, CBM, gross weight, warehouse/CFS, commodity?
3. Với Air cần những field nào: AOL, AOD, chargeable weight, gross weight, dimension, commodity?
4. Với Trucking cần những field nào: điểm lấy/giao hàng, loại xe, tải trọng, container type, thời gian lấy hàng?
5. Với Customs cần những field nào: loại hình XNK, HS code, invoice, packing list, giấy phép/chuyên ngành?

Vì sao cần cho Odoo:
- Xác định field trên CRM, Pricing Request và Quotation.
- Xác định validation bắt buộc theo từng service.

## 5. Master Data và nguồn giá

1. Pricing lấy giá từ những nguồn nào: carrier, agent, co-loader, vendor trucking, vendor customs, bảng giá nội bộ, email, website?
2. Carrier/agent/co-loader/vendor đang quản lý ở đâu và cần những thông tin master nào?
3. Có danh sách carrier/agent ưu tiên theo tuyến/dịch vụ không?
4. Có cần đánh giá vendor theo transit time, free time, lịch tàu, uy tín, công nợ, service level không?
5. Giá nhận qua email/Zalo/điện thoại có cần lưu attachment/source làm bằng chứng không?

Vì sao cần cho Odoo:
- Thiết kế Partner Master Data và vendor type.
- Thiết kế link từ rate line về carrier/agent/vendor.
- Thiết kế attachment/source document cho từng giá.

## 6. Bảng giá cước / Freight Pricelist

1. Một dòng bảng giá cần những field nào?
2. Bảng giá có tách theo freight charge, local charge, service charge, trucking, customs, commission, surcharge không?
3. Có quản lý `valid from` và `valid to` không?
4. Có quản lý currency, unit, container type, CBM/KG, route, carrier/agent, transit time, free time không?
5. Có lưu điều kiện áp dụng của giá không: commodity, volume tối thiểu, khách hàng, incoterm, carrier note?
6. Có cần import bảng giá từ Excel không?
7. Format Excel từ carrier/agent có cố định không hay mỗi bên một mẫu?
8. Có cần lưu lịch sử thay đổi bảng giá không?

Vì sao cần cho Odoo:
- Thiết kế model `freight.rate`/pricelist.
- Xác định import template.
- Xác định search rate và price comparison.

## 7. Cấu trúc charge line trên Quotation

1. Danh sách charge type chuẩn cần có là gì?
2. Đơn vị tính chuẩn gồm những gì: shipment, container, CBM, KG, ton, set, bill, day, trip?
3. Có cần tách buying price và selling price theo từng dòng phí không?
4. Có cần quản lý payer/payee/vendor/carrier theo từng dòng phí không?
5. Có phí nào có VAT khác mức thông thường hoặc không tính VAT không?
6. Có trường hợp refund/rebate/commission hoặc giá âm không?
7. Có cần multi-currency trên cùng một quotation không?

Vì sao cần cho Odoo:
- Thiết kế quotation line.
- Thiết kế tính tổng buying/selling/VAT/profit.
- Thiết kế kế toán sau này.

## 8. Quy tắc tính giá, VAT, profit và tỷ giá

1. Selling price do Pricing nhập, Sales/BD nhập, hay hệ thống gợi ý markup?
2. Markup tính theo %, số tiền cố định, tuyến, khách hàng, dịch vụ hay nhập tay?
3. Có margin tối thiểu không?
4. Khi selling thấp hơn buying, profit âm hoặc margin thấp thì có cần cảnh báo/approval không?
5. VAT tính theo từng dòng phí hay theo tổng báo giá?
6. Tỷ giá lấy theo ngày báo giá, ngày chốt booking, ngày xuất hóa đơn hay ngày kế toán ghi nhận?

Vì sao cần cho Odoo:
- Thiết kế computed fields.
- Thiết kế approval rule.
- Thiết kế cảnh báo và currency conversion.

## 9. Search Rate / Compare Rate

1. Khi search rate, user sẽ nhập tiêu chí nào: direction, service, POL/POD, carrier, container type, valid date?
2. Kết quả so sánh cần hiển thị những cột nào: carrier, agent, service, buying, currency, local charge, total cost, transit time, free time, validity, note?
3. Hệ thống nên chọn giá tốt nhất theo tiêu chí nào: thấp nhất, transit time, carrier ưu tiên, total cost?
4. Có cần lưu lại các phương án không được chọn không?
5. Khi Apply giá vào quotation, hệ thống cần tạo những charge line nào?

Vì sao cần cho Odoo:
- Thiết kế wizard Search Rate/Price Comparison.
- Xác định logic apply rate vào quotation.

## 10. Phản hồi giá và báo giá khách hàng

1. Pricing phản hồi giá cho ai: Sales/BD, CS hay khách hàng?
2. Nội dung phản hồi giá bắt buộc gồm những gì?
3. Có cần tách phần internal buying cost và phần quote gửi khách không?
4. Sales/BD có được thấy buying cost và profit không?
5. Có nhiều mẫu báo giá theo dịch vụ không: FCL, LCL, Air, Trucking/Customs?
6. Khi khách yêu cầu revise, hệ thống sửa quotation cũ hay tạo revision mới?
7. Quotation hết hạn thì xử lý thế nào?

Vì sao cần cho Odoo:
- Xác định template PDF/email.
- Xác định phân quyền hiển thị cost/profit.
- Thiết kế revision/version của quotation.

## 11. Chốt giá và bàn giao sang CS/Operation

1. Khi khách đồng ý giá, ai confirm quotation?
2. Sau confirm có cần khóa giá không?
3. Internal Booking cần những thông tin bắt buộc nào để CS/Operation tạo Job?
4. Pricing cần bàn giao những thông tin giá nào sang Job: buying, selling, vendor, payer/payee, source rate, validity?
5. Nếu carrier thay đổi giá sau khi khách confirm thì xử lý thế nào?
6. Có cần đối chiếu quotation, internal booking, vendor bill và debit note không?

Vì sao cần cho Odoo:
- Thiết kế luồng Quotation -> Internal Booking -> Job.
- Thiết kế lock/unlock quotation.
- Chuẩn bị dữ liệu cho vận hành và kế toán.

## 12. Phân quyền

1. Ai được xem buying price?
2. Ai được sửa buying price?
3. Ai được xem profit/margin?
4. Sales/BD được xem cost đến mức nào?
5. CS/OP cần xem buying/selling hay chỉ cần thông tin booking/job?
6. Ai được override cảnh báo margin thấp, giá hết hạn, VAT bất thường?
7. Có cần log lịch sử người sửa giá không?

Vì sao cần cho Odoo:
- Thiết kế security group.
- Thiết kế readonly/invisible field.
- Thiết kế audit trail/chatter.

## 13. Báo cáo tối thiểu

1. Pricing cần dashboard/report nào ở MVP?
2. Có cần theo dõi số lượng request check giá theo ngày/tuần/tháng không?
3. Có cần theo dõi thời gian xử lý trung bình một request không?
4. Có cần theo dõi số request pending carrier/agent không?
5. Có cần theo dõi tỷ lệ quote won/lost theo carrier, tuyến, dịch vụ không?
6. Có cần theo dõi gross profit/margin theo khách hàng, tuyến, Sales/BD, carrier không?

Vì sao cần cho Odoo:
- Xác định report/pivot/dashboard.
- Xác định trường cần capture ngay từ đầu để sau này báo cáo được.

## 14. Dữ liệu mẫu bắt buộc phải xin

1. File bảng giá carrier/agent/co-loader thực tế.
2. File/email báo giá carrier gửi về.
3. Mẫu request check giá từ Sales/BD sang Pricing.
4. Mẫu phản hồi giá từ Pricing sang Sales/BD.
5. Mẫu báo giá gửi khách hàng.
6. Một case check giá Export FCL/LCL hoàn chỉnh.
7. Một case check giá Import FCL/LCL hoàn chỉnh.
8. Một case Air nếu có.
9. Một case Trucking/Customs nếu Pricing phụ trách.
10. Danh sách charge type/phụ phí đang dùng.

Vì sao cần cho Odoo:
- Dùng để thiết kế field, import template, quotation layout và test case UAT.

## 15. Câu hỏi chốt MVP

1. MVP ưu tiên phần nào trước: Rate Management, Pricing Request, Search Rate, Price Comparison, Quotation Charges hay Dashboard?
2. MVP có bắt buộc import bảng giá Excel không?
3. MVP có cần quản lý đầy đủ phụ phí hay chỉ nhóm phí chính?
4. MVP có cần approval margin thấp/profit âm không?
5. MVP có cần xuất PDF quotation không?
6. MVP có cần tự tạo Internal Booking/Job sau khi khách confirm không?
7. Chỉ số thành công của MVP với Pricing là gì?
