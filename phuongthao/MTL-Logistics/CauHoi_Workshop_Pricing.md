# Câu hỏi khai thác nghiệp vụ Pricing - MTL Logistics

## 1. Vai trò và phạm vi công việc của Pricing

1. Bộ phận Pricing hiện phụ trách những loại dịch vụ nào: Sea FCL, Sea LCL, Air, Trucking, Customs, dịch vụ local, dịch vụ khác?
2. Pricing có trực tiếp làm việc với khách hàng không, hay chỉ nhận yêu cầu từ Sales/CS/Operation?
3. Pricing chịu trách nhiệm đến bước nào trong quy trình: check buying cost, đề xuất selling price, gửi báo giá, hay chỉ phản hồi giá cho Sales?
4. Những đầu việc nào Pricing làm hằng ngày nhiều nhất?
5. Một ngày trung bình Pricing xử lý bao nhiêu yêu cầu check giá?
6. Có phân chia nhân sự Pricing theo tuyến, dịch vụ, khách hàng, carrier/agent hay theo chi nhánh không?
7. Ai là người duyệt cuối cùng khi có giá đặc biệt, margin thấp hoặc giá ngoài bảng?
8. Pricing đang phối hợp với Sales, CS, OP và Kế toán ở những điểm nào?

## 2. Tiếp nhận yêu cầu check giá

1. Pricing nhận yêu cầu check giá từ những nguồn nào: Sales, CS, khách hàng, email, Zalo, điện thoại, Excel, hệ thống hiện tại?
2. Khi Sales gửi yêu cầu check giá, họ thường gửi qua kênh nào?
3. Có mẫu yêu cầu check giá chuẩn không? Nếu có, gồm những trường nào?
4. Những thông tin tối thiểu Pricing cần có để bắt đầu check giá là gì?
5. Nếu thiếu thông tin, Pricing xử lý thế nào: trả lại Sales, hỏi trực tiếp khách, tự ước lượng, hay vẫn check tạm?
6. Có phân loại mức độ ưu tiên cho yêu cầu check giá không: urgent, khách VIP, tender, spot rate, regular shipment?
7. Có deadline/SLA nội bộ cho việc phản hồi giá không?
8. Có tracking được yêu cầu nào đang chờ carrier/agent phản hồi không?
9. Một yêu cầu check giá có thể bao gồm nhiều tuyến/nhiều dịch vụ/nhiều container type không?
10. Có trường hợp Sales gửi nhiều lần cho cùng một yêu cầu do thay đổi thông tin không? Pricing đang quản lý version như thế nào?

## 3. Thông tin đầu vào cần thu thập

1. Với Sea FCL, Pricing cần những thông tin nào: POL, POD, container type, số container, commodity, gross weight, ETD, incoterm, carrier yêu cầu, free time?
2. Với Sea LCL, Pricing cần những thông tin nào: POL, POD, CBM, gross weight, commodity, dimension, warehouse, CFS/CFS hay door service?
3. Với Air, Pricing cần những thông tin nào: AOL, AOD, chargeable weight, gross weight, dimension, commodity, airline yêu cầu, transit time?
4. Với Trucking, Pricing cần những thông tin nào: điểm lấy/giao hàng, loại xe, tải trọng, container type, thời gian lấy hàng, yêu cầu nâng hạ?
5. Với Customs, Pricing cần những thông tin nào: loại hình XNK, HS code, commodity, invoice, packing list, giấy phép/chuyên ngành?
6. Commodity nào cần lưu ý đặc biệt: hàng nguy hiểm, hàng lạnh, pin, hóa chất, máy móc cũ, thực phẩm, mỹ phẩm?
7. Có cần thông tin về term thanh toán, credit, hoặc đối tượng payer/payee ngay từ bước check giá không?
8. Có cần kiểm tra blacklist/sanction hoặc hạn chế quốc gia/tuyến không?

## 4. Nguồn giá và cách hỏi giá

1. Pricing hiện lấy giá từ những nguồn nào: bảng giá carrier, bảng giá agent, email, website carrier, co-loader, file PDF/Excel, hợp đồng riêng?
2. Nguồn giá nào được ưu tiên trước?
3. Khi nào dùng giá có sẵn trong bảng, khi nào phải hỏi lại carrier/agent?
4. Thường mỗi yêu cầu Pricing hỏi bao nhiêu carrier/agent/co-loader?
5. Có danh sách carrier/agent ưu tiên theo từng tuyến không?
6. Có carrier/agent nào chỉ dùng cho một số dịch vụ hoặc tuyến đặc thù không?
7. Có tiêu chí đánh giá nhà cung cấp ngoài giá không: transit time, free time, lịch tàu, uy tín, khả năng giữ booking, công nợ, service level?
8. Khi nhận giá qua email, Pricing có lưu email đó làm bằng chứng không?
9. Nếu carrier/agent báo giá bằng nhiều format khác nhau, Pricing đang chuẩn hóa lại như thế nào?
10. Có trường hợp giá qua điện thoại/Zalo không có file xác nhận không? Nếu có thì lưu vết ra sao?

## 5. Quản lý bảng giá

1. Hiện bảng giá đang được quản lý ở đâu: Excel cá nhân, shared folder, email, phần mềm FAST/Odoo, Google Sheet?
2. Có bao nhiêu loại bảng giá chính đang dùng?
3. Bảng giá có tách theo freight charge, local charge, service charge, trucking, customs, commission không?
4. Một dòng bảng giá hiện gồm những trường nào?
5. Có quản lý ngày hiệu lực `valid from` và `valid to` không?
6. Có quản lý currency theo từng dòng phí không?
7. Có quản lý container type/volume/unit không?
8. Có quản lý transit time, free time, cut-off, sailing schedule không?
9. Có lưu điều kiện áp dụng của giá không: commodity, volume tối thiểu, khách hàng, tuyến, incoterm, carrier note?
10. Có lưu phụ phí đi kèm không: THC, DO, BL, CIC, EBS, PSS, AMS, ISF, handling, security, fuel surcharge?
11. Khi carrier cập nhật bảng giá mới, ai nhập/cập nhật vào file?
12. Có quy trình kiểm tra lại sau khi nhập bảng giá không?
13. Có lưu lịch sử thay đổi giá không: ai sửa, sửa lúc nào, giá cũ/giá mới?
14. Có cần import bảng giá từ Excel vào hệ thống không?
15. Format Excel từ carrier/agent có ổn định không hay mỗi bên một mẫu?

## 6. Cấu trúc phí và cách tính giá

1. MTL đang phân loại charge như thế nào?
2. Danh sách charge type chuẩn cần dùng trong hệ thống gồm những loại nào?
3. Đơn vị tính thường dùng là gì: shipment, container, CBM, KG, ton, set, bill, day, trip?
4. Có trường hợp cùng một phí nhưng đơn vị tính khác nhau theo dịch vụ không?
5. Buying price và selling price hiện được quản lý tách riêng như thế nào?
6. Selling price do Pricing đề xuất hay Sales tự nhập markup?
7. Có quy tắc markup chuẩn không: theo %, theo số tiền cố định, theo tuyến, theo khách hàng, theo dịch vụ?
8. Có mức margin tối thiểu không?
9. Nếu profit âm hoặc margin thấp, quy trình xử lý/duyệt như thế nào?
10. VAT được tính theo từng dòng phí hay theo tổng báo giá?
11. Có phí nào không tính VAT hoặc VAT khác mức thông thường không?
12. Có trường hợp refund, rebate, commission hoặc giá âm không?
13. Có quản lý payer/payee cho từng dòng phí không?
14. Có cần tách giá thu khách và giá trả vendor/agent/carrier theo từng dòng không?
15. Có cần tính tổng theo nhiều currency và quy đổi về VND không?
16. Tỷ giá lấy theo ngày nào: ngày báo giá, ngày chốt booking, ngày xuất hóa đơn, hay ngày kế toán ghi nhận?

## 7. So sánh giá và chọn phương án

1. Khi có nhiều giá từ nhiều carrier/agent, Pricing so sánh theo tiêu chí nào?
2. Giá thấp nhất có luôn được chọn không? Nếu không, lý do thường là gì?
3. Có cần hệ thống highlight giá tốt nhất theo từng tiêu chí không?
4. Có cần so sánh nhiều phương án theo bảng: carrier, agent, transit time, free time, local charge, total cost, note?
5. Có cần so sánh tổng landed cost thay vì chỉ freight cost không?
6. Có cần lưu lại các phương án không được chọn để tham chiếu sau này không?
7. Khi chọn một phương án, cần lưu lý do chọn không?
8. Có case khách yêu cầu carrier/airline cụ thể dù giá cao hơn không?
9. Có case phải split shipment qua nhiều carrier/agent không?
10. Pricing có cần cảnh báo giá hết hạn hoặc sắp hết hạn khi chọn giá không?

## 8. Phản hồi giá cho Sales/khách hàng

1. Sau khi check xong, Pricing phản hồi cho ai: Sales, khách hàng, CS hay group nội bộ?
2. Pricing phản hồi bằng format nào: email, file Excel, form quotation, chat, hay nhập vào hệ thống?
3. Nội dung phản hồi giá bắt buộc gồm những gì?
4. Có cần tách phần internal buying cost và phần selling quote gửi khách không?
5. Sales có được thấy toàn bộ buying cost không?
6. Pricing có đề xuất selling price cuối cùng không, hay chỉ cung cấp buying cost?
7. Có cần ghi chú điều kiện báo giá không: validity, space subject to availability, schedule subject to change, local charge excluded/included?
8. Có template email/form báo giá chuẩn không?
9. Có nhiều mẫu báo giá theo dịch vụ không: FCL, LCL, Air, Trucking/Customs?
10. Khi khách yêu cầu revise giá, Pricing tạo báo giá mới hay sửa trên báo giá cũ?
11. Có cần quản lý version báo giá gửi khách không?
12. Báo giá hết hạn thì xử lý thế nào?

## 9. Chốt giá và bàn giao sau khi khách đồng ý

1. Khi khách đồng ý giá, Pricing có tham gia bước confirm không?
2. Ai là người chuyển thông tin sang CS/Operation?
3. Internal Booking hiện gồm những thông tin gì?
4. Pricing cần bàn giao những thông tin nào để CS/OP booking đúng giá?
5. Có cần khóa giá sau khi khách confirm không?
6. Nếu carrier thay đổi giá sau khi khách đã confirm, quy trình xử lý thế nào?
7. Nếu Sales nhập sai giá hoặc thiếu phí trong Internal Booking, Pricing có kiểm tra lại không?
8. Có bước đối chiếu giữa quotation, internal booking, vendor bill và debit note không?
9. Khi phát sinh phí ngoài báo giá ban đầu, ai cập nhật và ai duyệt?
10. Có cần lưu chứng từ xác nhận giá từ carrier/agent gắn với job/shipment không?

## 10. Kiểm soát rủi ro và cảnh báo

1. Những lỗi Pricing thường gặp nhất hiện nay là gì?
2. Có hay xảy ra sai currency, sai VAT, sai đơn vị tính hoặc sai container type không?
3. Có hay dùng nhầm bảng giá hết hạn không?
4. Có hay thiếu local charge/phụ phí khi báo giá không?
5. Có trường hợp cùng một tuyến nhưng carrier/agent báo nhiều điều kiện khác nhau gây nhầm không?
6. Hệ thống cần cảnh báo những tình huống nào?
7. Có cần cảnh báo nếu selling price thấp hơn buying price không?
8. Có cần cảnh báo nếu margin thấp hơn mức tối thiểu không?
9. Có cần cảnh báo nếu giá đã quá hạn validity không?
10. Có cần cảnh báo nếu chọn giá không khớp service/container/route không?
11. Có cần cảnh báo nếu VAT hoặc currency khác thông lệ không?
12. Ai nhận cảnh báo và ai có quyền override?

## 11. Báo cáo và KPI của Pricing

1. Pricing hiện đang có báo cáo định kỳ không?
2. Báo cáo Pricing gửi cho ai và theo tần suất nào?
3. Các chỉ số hiện đang theo dõi là gì?
4. Có theo dõi số lượng yêu cầu check giá theo ngày/tuần/tháng không?
5. Có theo dõi thời gian xử lý trung bình một yêu cầu không?
6. Có theo dõi số yêu cầu pending carrier/agent không?
7. Có theo dõi tỷ lệ báo giá thành công/chốt đơn theo carrier, tuyến, dịch vụ không?
8. Có theo dõi gross profit/margin theo tuyến, khách hàng, Sales, carrier không?
9. Có theo dõi carrier/agent nào được chọn nhiều nhất không?
10. Có cần dashboard riêng cho Pricing Manager không?
11. Ban Giám đốc thường cần xem báo cáo nào liên quan Pricing?
12. Những báo cáo nào hiện đang làm thủ công bằng Excel?

## 12. Phân quyền và dữ liệu nhạy cảm

1. Ai được xem bảng giá buying?
2. Ai được sửa bảng giá buying?
3. Ai được xem profit/margin?
4. Sales được xem buying cost đến mức nào?
5. CS/OP có cần xem buying/selling không hay chỉ cần thông tin booking?
6. Có cần ẩn một số phí nội bộ với khách hàng không?
7. Có cần phân quyền theo chi nhánh, phòng ban, tuyến hoặc khách hàng không?
8. Có cần log lịch sử người xem/sửa giá không?
9. Có cần quy trình phê duyệt khi sửa báo giá đã gửi khách không?
10. Có cần khóa báo giá sau khi đã confirm không?

## 13. Dữ liệu mẫu cần xin trong workshop

1. Một file bảng giá carrier/agent thực tế.
2. Một file/email báo giá carrier gửi về.
3. Một mẫu phản hồi giá nội bộ từ Pricing sang Sales.
4. Một mẫu báo giá gửi khách hàng.
5. Một case check giá FCL hoàn chỉnh.
6. Một case check giá LCL hoặc Air hoàn chỉnh.
7. Một case Trucking/Customs nếu Pricing phụ trách.
8. Danh sách charge type/phụ phí thường dùng.
9. Danh sách carrier/agent/co-loader thường xuyên hợp tác.
10. Một báo cáo Pricing hoặc báo cáo hiệu quả báo giá hiện tại, nếu có.

## 14. Câu hỏi chốt phạm vi MVP

1. Trong giai đoạn đầu, Pricing cần hệ thống hỗ trợ phần nào trước: nhập bảng giá, search rate, compare rate, quotation charge line hay dashboard?
2. Với MVP, có cần import bảng giá từ Excel ngay không?
3. Với MVP, có cần quản lý đầy đủ phụ phí hay chỉ nhóm phí chính?
4. Với MVP, Price Comparison cần so sánh theo total cost hay chỉ buying freight?
5. Với MVP, ai là người nhập selling price: Pricing hay Sales?
6. Với MVP, có cần approval margin thấp/profit âm không?
7. Với MVP, có cần xuất PDF quotation không, hay chỉ cần phản hồi giá nội bộ?
8. Với MVP, sau khi khách chốt có cần tự tạo Internal Booking/Job không?
9. Chỉ số thành công của MVP với Pricing là gì: giảm thời gian check giá, giảm lỗi sai, tăng tỷ lệ chốt, quản lý tập trung bảng giá?
10. Dữ liệu nào bắt buộc phải migrate/import trước khi go-live?
