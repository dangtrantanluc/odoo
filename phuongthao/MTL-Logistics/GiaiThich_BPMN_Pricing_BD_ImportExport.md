# Giải thích BPMN Pricing - BD có Import/Export

## 1. Nhận xét tổng quan

BPMN hiện tại mới thể hiện phần Pricing khá mỏng, chủ yếu là bước check giá. Trong tài liệu MTL, quy trình logistics cần tách theo:

- Direction: Export / Import
- Mode: Air / FCL / LCL
- Dịch vụ bổ sung: Trucking / Customs / Local charge / Service charge

Vì vậy, khi sửa BPMN không nên coi Pricing là một bước chung duy nhất. Pricing cần được mô hình hóa thành một sub-process, còn BD/Sales là luồng riêng từ lead, nhận yêu cầu, gửi request pricing, báo giá và chốt đơn.

## 2. Import/Export ảnh hưởng gì đến Pricing?

### Export

Export là luồng hàng xuất từ Việt Nam đi nước ngoài.

Pricing thường cần check:

- Freight từ POL Việt Nam đến POD nước ngoài.
- Local charge đầu xuất tại Việt Nam: THC, BL, seal, handling, CFS, CIC, chứng từ.
- Trucking nội địa nếu có lấy hàng từ kho khách ra cảng/sân bay.
- Customs export nếu MTL làm thủ tục hải quan xuất.
- Phụ phí carrier/agent theo tuyến.
- Transit time, ETD, cut-off, SI cut-off, CY closing.
- Free time/detention/demurrage nếu liên quan.

Chứng từ export trong tài liệu hiện trạng có nhắc:

- Booking
- SI
- MBL/HBL hoặc MAWB/HAWB
- VGM
- Manifest
- Shipping Instruction
- Debit Note

### Import

Import là luồng hàng nhập từ nước ngoài về Việt Nam.

Pricing thường cần check:

- Freight từ POL nước ngoài về POD Việt Nam, nếu MTL phụ trách.
- Local charge đầu nhập tại Việt Nam: DO, THC, CFS, CIC, cleaning, handling, local charge.
- Trucking giao hàng từ cảng/sân bay về kho khách.
- Customs import nếu MTL làm thủ tục hải quan nhập.
- Phí hãng tàu/agent tại đầu nhập.
- Arrival Notice, EDO, lưu cont/lưu bãi nếu phát sinh.
- Quy định nhập khẩu theo POD/quốc gia/hàng hóa: HS code, giấy phép, chính sách mặt hàng.

Chứng từ import trong tài liệu hiện trạng có nhắc:

- MBL/HBL hoặc MAWB/HAWB
- Manifest
- Arrival Notice
- Debit Note Agent
- Invoice/Packing List
- EDO

## 3. Khác biệt nghiệp vụ Pricing giữa Export và Import

| Nhóm nghiệp vụ | Export | Import |
|---|---|---|
| Điểm trọng tâm | Giá đi từ Việt Nam ra nước ngoài | Giá từ nước ngoài về Việt Nam và chi phí đầu nhập |
| Nguồn giá | Carrier/agent/co-loader cho tuyến xuất | Agent nước ngoài, carrier, local charge đầu nhập |
| Deadline quan trọng | ETD, CY closing, SI cut-off, VGM, Manifest | ETA, Manifest, Arrival Notice, EDO, free time |
| Chi phí hay gặp | Freight, THC, BL, seal, trucking pickup, customs export | Freight, DO, THC, CFS, cleaning, trucking delivery, customs import |
| Rủi ro | Miss SI/cut-off, sai booking, thiếu local charge | Hàng về chưa có chứng từ, rớt manifest, phát sinh lưu cont/lưu bãi |
| Thông tin cần check thêm | Lịch tàu/chuyến bay, closing time, carrier schedule | Quy định nhập khẩu, giấy phép, HS code, EDO, thời gian lấy hàng |

## 4. BD/Sales nên nằm ở đâu trong BPMN?

BD/Sales không nên bị gom vào Pricing. BD/Sales là người tiếp nhận và phát triển cơ hội kinh doanh:

1. Nhận lead/yêu cầu từ khách hàng.
2. Qualify khách: khách mới/cũ, tuyến, volume, loại dịch vụ, tiềm năng.
3. Thu thập thông tin shipment.
4. Xác định hướng hàng: Export hay Import.
5. Xác định mode: FCL/LCL/Air/Trucking/Customs.
6. Gửi request check giá cho Pricing.
7. Nhận kết quả giá từ Pricing.
8. Lập/gửi quotation cho khách.
9. Follow-up khách: đồng ý, yêu cầu revise, từ chối.
10. Nếu khách đồng ý: tạo Internal Booking và bàn giao CS.

## 5. Pricing nên được thể hiện thành sub-process

Sub-process Pricing đề xuất:

1. Nhận yêu cầu check giá từ BD/Sales.
2. Kiểm tra thông tin đầu vào.
3. Gateway: Thông tin đủ chưa?
   - Nếu chưa đủ: trả lại BD/Sales bổ sung.
   - Nếu đủ: tiếp tục.
4. Phân loại yêu cầu:
   - Export / Import
   - FCL / LCL / Air / Trucking / Customs
5. Tra bảng giá nội bộ.
6. Gateway: Có giá hợp lệ không?
   - Nếu có: dùng giá làm phương án ban đầu.
   - Nếu không: hỏi carrier/agent/co-loader.
7. Nhận giá từ carrier/agent/co-loader.
8. Chuẩn hóa giá:
   - Currency
   - Unit
   - Validity
   - Freight/local/surcharge/service charge
   - Transit time/free time
9. So sánh phương án giá.
10. Tính buying cost, selling price/markup, VAT, profit/margin.
11. Gateway: Giá/margin có cần duyệt không?
12. Phản hồi giá cho BD/Sales.
13. Lưu nguồn giá và cập nhật bảng giá nếu cần.

## 6. BPMN nên thêm gateway nào?

1. Thông tin yêu cầu đã đủ chưa?
2. Direction là Export hay Import?
3. Mode là FCL/LCL/Air/Trucking/Customs?
4. Có giá hợp lệ trong bảng giá chưa?
5. Có cần hỏi carrier/agent/co-loader không?
6. Carrier/agent đã phản hồi chưa?
7. Giá có còn hiệu lực không?
8. Margin/profit có đạt rule không?
9. Có cần manager duyệt giá đặc biệt không?
10. Khách có đồng ý báo giá không?
11. Khách yêu cầu revise không?
12. Internal Booking đã đủ thông tin để CS tạo Job chưa?

## 7. Flow BPMN đề xuất ở mức tổng quan

1. Customer gửi nhu cầu.
2. BD/Sales tiếp nhận lead/yêu cầu.
3. BD/Sales thu thập thông tin shipment.
4. BD/Sales phân loại Export/Import và mode dịch vụ.
5. BD/Sales gửi request check giá cho Pricing.
6. Pricing kiểm tra thông tin đầu vào.
7. Pricing tra bảng giá hoặc hỏi carrier/agent/co-loader.
8. Pricing chuẩn hóa và so sánh giá.
9. Pricing tính buying/selling/profit/VAT.
10. Pricing phản hồi giá cho BD/Sales.
11. BD/Sales lập quotation gửi khách.
12. Customer phản hồi.
13. Nếu revise: quay lại Pricing.
14. Nếu đồng ý: BD/Sales tạo Internal Booking.
15. CS nhận Internal Booking và tạo Job.
16. Job đi vào luồng vận hành Export/Import tương ứng.

## 8. Dữ liệu cần có trên request Pricing

Các field tối thiểu nên hỏi trong workshop:

- Customer
- Direction: Export / Import
- Mode: FCL / LCL / Air / Trucking / Customs
- POL/AOL
- POD/AOD
- Final destination
- Incoterm
- Commodity
- HS code nếu có
- Gross weight
- CBM
- Quantity/package
- Container type nếu FCL
- ETD/ETA mong muốn
- Carrier/agent yêu cầu nếu có
- Service scope: port-port, door-port, port-door, door-door
- Yêu cầu trucking/customs/local charge
- Ghi chú đặc biệt về hàng hóa/quốc gia/POD

## 9. Điểm cần hỏi thêm trong workshop

1. Với Export, Pricing đang check những nhóm phí nào là bắt buộc?
2. Với Import, Pricing đang check những nhóm phí nào là bắt buộc?
3. Import có cần Pricing kiểm tra chính sách mặt hàng/HS code/quy định POD không?
4. Export có cần Pricing kiểm tra cut-off/SI/VGM/Manifest deadline không?
5. Bảng giá hiện có tách theo Export/Import không?
6. Bảng giá hiện có tách theo FCL/LCL/Air/Trucking/Customs không?
7. Một quotation có thể gồm cả freight + trucking + customs không?
8. Ai quyết định selling price cuối cùng: Pricing hay BD/Sales?
9. Nếu khách revise route/mode/volume thì tạo request mới hay sửa request cũ?
10. Khi khách chốt, thông tin giá nào phải bàn giao sang CS để tạo Job?
