# MTL Sales - Next Step UI cho Quotation

## Mục tiêu bước tiếp theo

Hoàn thiện màn hình `Freight Management > Quotations` để Sales có thể lập báo giá thật:

1. Nhập thông tin báo giá.
2. Nhập các dòng phí buying/selling.
3. Tự tính profit trước VAT.
4. Chuẩn bị cho bước sau: Search Rate, PDF báo giá, Confirm tạo Job/Shipment.

Theo UI hiện tại, không cần đổi toàn bộ màn hình. Chỉ cần sắp lại form và thêm tab/dòng phí.

## Vấn đề UI hiện tại

- Form đang có khung tốt: Header, Commercial Basis, Shipment Parties, System Fields.
- Nhưng phần quan trọng nhất của Sales chưa nổi bật: bảng phí, giá mua, giá bán, VAT, profit.
- `Commercial Basis` đang để bên phải header, ổn nhưng nên thêm thông tin tổng tiền.
- Chưa thấy nút hành động cho Sales: `Search Rate`, `Print Quotation`, `Send Email`, `Duplicate/Renew`.
- Status hiện tại `Quotation -> Confirmed -> In Progress -> Done` dùng được cho job, nhưng với báo giá nên có thêm trạng thái rõ hơn: `Draft/Quotation -> Sent -> Accepted/Confirmed -> In Progress -> Done` hoặc giữ hiện tại nhưng đổi label khi cần.

## UI đề xuất cho form Quotation

### Header actions

Giữ:
- `Confirm`
- `Cancel`

Thêm:
- `Search Rate`
- `Print Quotation`
- `Send by Email`
- `Duplicate/Renew`

Sau này khi record đã Confirmed/In Progress:
- Ẩn hoặc khóa sửa trực tiếp các trường chính.
- Hiện nút `Request Modify`.

### Status bar

Giai đoạn MVP có thể giữ status hiện tại:

`Quotation -> Confirmed -> In Progress -> Done`

Nhưng nên hiểu nghiệp vụ như sau:

- `Quotation`: Sales đang soạn báo giá.
- `Confirmed`: khách đã đồng ý, chuẩn bị chuyển job/shipment.
- `In Progress`: CS/Operation đang xử lý.
- `Done`: job hoàn tất.

## Layout form đề xuất

```text
JOB/2026/05/0367

[Search Rate] [Print Quotation] [Send by Email] [Duplicate/Renew] [Confirm] [Cancel]

Quotation Header                         Commercial Summary
---------------------------------------------------------------
Customer *                               Currency
Subject                                  VAT %
To                                       Total Buying
PIC                                      Total Selling
Valid Until                              Profit
Salesperson                              Profit %

Route & Service                          Shipment Parties
---------------------------------------------------------------
Direction                                Shipper
Service Type                             Consignee
POL                                      Notify Party
POD
Incoterm
Carrier
Container Type
Commodity

Tabs:
[Charges] [Terms & Notes] [Advanced] [Modification History]
```

## Tab Charges - bắt buộc làm trước

Đây là phần cần build ngay.

### Dòng phí

Các cột đề xuất:

| Field | Ghi chú |
|---|---|
| Charge Type | Chọn phí chuẩn: Ocean Freight, THC, DO, BL, Trucking, Customs, Handling, Other |
| Description | Mô tả chi tiết; bắt buộc với Trucking/Other |
| Unit | Shipment, Container, CBM, KG, Day |
| Qty | Số lượng |
| Currency | USD/VND |
| Buying Unit Price | Giá mua |
| Selling Unit Price | Giá bán |
| Buying Amount | Qty x Buying |
| Selling Amount | Qty x Selling |
| VAT % | VAT cho phí tại Việt Nam |
| Profit | Selling Amount - Buying Amount, chưa gồm VAT |
| Payer | Ai trả tiền |
| Payee | Ai nhận tiền |
| Vendor/Carrier | Nhà cung cấp/hãng tàu/agent |

### Tổng tiền

Cuối tab Charges cần có summary:

```text
Total Buying:   xxx
Total Selling:  xxx
VAT Amount:     xxx
Profit:         xxx
Profit %:       xxx
```

### Rule tính

- `Buying Amount = Qty * Buying Unit Price`
- `Selling Amount = Qty * Selling Unit Price`
- `Profit = Selling Amount - Buying Amount`
- `VAT Amount = Selling Amount * VAT %`
- `Total Customer Pay = Selling Amount + VAT Amount`
- Profit tính trước VAT.
- Cho phép số âm cho refund/cước hoàn lại.
- `Other Charges` phải cho nhập description tự do.

## Search Rate flow

Nút `Search Rate` trên quotation mở wizard:

```text
Search Rate
------------------------------------------------
POL
POD
Service Type
Carrier
Container Type
Valid Date

[Search]

Results:
Carrier | Service | Container | Buying | Currency | Valid Until | Note | [Apply]
```

Khi bấm `Apply`:

- Tạo dòng charge trong tab `Charges`.
- Copy carrier/vendor.
- Copy currency.
- Copy buying price.
- Sales tự nhập selling price hoặc hệ thống gợi ý markup.

## Create Quotation từ CRM Lead

Trên form CRM Lead thêm nút:

`Create Quotation`

Copy dữ liệu:

| CRM Lead | Quotation |
|---|---|
| Contact/Customer | Customer |
| Email | To hoặc contact email |
| Salesperson | Salesperson |
| Direction | Direction |
| Service Type | Service Type |
| POL | POL |
| POD | POD |
| Expected Revenue | Selling estimate nếu cần |

Sau khi tạo, trên Lead hiển thị smart button:

`Quotations (n)`

## Request Modify - để sau charge lines

Chỉ làm sau khi đã có charge lines và confirm flow.

UI:

```text
[Request Modify]

Reason *
Fields to change
Requested changes / Notes

[Submit Request]
```

Manager thấy:

```text
[Approve] [Reject]
```

Khi approve:

- Mở khóa record trong một thời gian cấu hình, ví dụ 24h.
- Log chatter: ai request, ai approve, lý do.
- Khi save thay đổi, log before/after của charge lines hoặc fields quan trọng.

## Thứ tự triển khai đề xuất

1. Thêm tab `Charges` và model charge line.
2. Thêm computed totals: buying, selling, VAT, profit, profit %.
3. Sửa list view quotation để hiển thị `Total Selling`, `Profit`, `Salesperson`, `Status`.
4. Thêm nút `Search Rate` nhưng wizard có thể dùng data mẫu trước.
5. Thêm nút `Create Quotation` từ CRM Lead.
6. Thêm PDF quotation.
7. Sau đó mới làm `Duplicate/Renew` và `Request Modify`.

## Definition of Done cho bước này

Một Sales có thể demo được luồng:

```text
CRM Lead
-> Create Quotation
-> Nhập customer/route/service
-> Add charge lines
-> Nhập buying/selling/VAT
-> Xem profit tự tính
-> Confirm quotation
```

Nếu làm xong bước này, phần Sales bắt đầu có giá trị sử dụng thật.
