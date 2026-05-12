# MTL Logistics - Workshop Prep: Pricing & BD

Ngay doc: 2026-05-11

## 1. Tai lieu da uu tien doc

- `Sales_NextStep_UI_Quotation.md`
- `7. Tai lieu Kick-off/(BBSW x MTL) _ TINH NANG CHI TIET DU AN LOGISTIC 21-4-2026.xlsx`
- `(MTL)x(BBSW) FRA-Feasibility and ROI Analysis.xlsx`
- `Phan hoi Feedback MTL Logistics.docx`
- `6.Tai lieu 240326/MTL_BaoCaoHienTrang_ChuyenDoiSo.docx`
- `6.Tai lieu 240326/MTL_DeXuat_v3_ChuyenDoiSo_ChiTiet.docx`
- `6.Tai lieu 240326/MTL_Spec_KyThuat_Odoo_UserStory_TestCase.docx`
- `6.Tai lieu 240326/MTL_HuongDanSuDung_Odoo.docx`

Luu y: 3 file trong `5.Du lieu MTL cung cap/tai lieu/Sale` dang co dung luong 0 byte:
`FORM QUOTATION.xlsx`, `REPORT CUSTOMER.xlsx`, `SALES MONTHLY.xlsx`.

## 2. Tom tat hien trang lien quan Pricing va BD

### Pricing / CS Pricing

- Hien tai phai check gia voi 3-4 dai ly x 3-4 carrier, dong thoi tu tim quy dinh xuat nhap khau theo tuyen/nuoc.
- Khoi luong tham chieu trong tai lieu: khoang 10 bao gia/ngay.
- Pain point chinh: mat thoi gian, kho xac minh tinh chinh xac nguon gia/quy dinh, de sai gia hoac thieu thong tin khi ban giao sang CS.
- Nhu cau P0 trong feedback: tra bang gia cuoc, so sanh nhieu carrier/dai ly, co transit time, phu phi chi tiet va notes/quy dinh theo POD.

### BD / Sales

- Hien trang Sale bao gia thu cong bang Excel/email, tai lieu de xuat ghi nhan thoi gian 30-40 phut/bao gia.
- Muc tieu: giam xuong khoang 5 phut/bao gia bang cach dung bang gia cuoc, so sanh gia va auto-populate charge lines.
- CRM can quan ly lead/opportunity, pipeline, follow-up va chuyen tu lead sang quotation.
- Khi khach chot, Sale can tao Internal Booking day du thong tin bat buoc de CS khong phai hoi lai.

## 3. Pham vi chuc nang da lap lai nhieu lan trong tai lieu

### CRM / BD Pipeline

- Pipeline de xuat: New/Contacted/Quoted/Negotiation/Won/Lost.
- Kick-off 21/04/2026 de xuat pipeline 5 giai doan: Tim kiem -> Gap go -> De xuat -> Dam phan -> Chot hop dong.
- Can chot mapping pipeline voi ngon ngu MTL dung thuc te.

### Quotation

- Loai bao gia: Sea FCL, Airfreight, LCL Rate, Trucking & Customs.
- Quotation can lien ket Lead, Customer, Salesperson, POL/AOL, POD/AOD, commodity, valid until, currency, notes.
- Trang thai trong spec: draft -> sent -> won -> lost -> expired.
- Ghi chu UI hien tai de xuat MVP co the dung: Quotation -> Confirmed -> In Progress -> Done, nhung nen lam ro y nghia rieng cho bao gia.

### Charge Lines / Pricing

Cot charge line can co:
- Charge Type
- Description
- Unit
- Qty
- Currency
- Buying Unit Price
- Selling Unit Price
- Buying Amount
- Selling Amount
- VAT %
- Profit
- Payer
- Payee
- Vendor/Carrier

Quy tac tinh:
- Buying Amount = Qty x Buying Unit Price
- Selling Amount = Qty x Selling Unit Price
- Profit = Selling Amount - Buying Amount, chua gom VAT
- VAT Amount = Selling Amount x VAT %
- Total Customer Pay = Selling Amount + VAT Amount
- Cho phep so am cho refund/cuoc hoan lai

### Freight Rate / Bang gia cuoc

Field duoc spec nhac toi:
- Carrier
- Agent
- Transport mode: air/fcl/lcl
- POL/POD
- Container type: 20GP/40GP/40HC/LCL/AIR
- Rate amount
- Currency
- Valid from/to
- Surcharges
- Transit time
- Notes

Can mo rong theo feedback Pricing/CS:
- Transit time
- Phu phi chi tiet
- Country regulations/notes tai POD

### Search Rate / Price Comparison

- Nguoi dung nhap POL, POD, service type, carrier, container type, valid date.
- Ket qua can hien carrier/service/container/buying/currency/valid until/note.
- Khi Apply vao quotation: tao charge line, copy carrier/vendor, currency, buying price; Sale nhap selling price hoac he thong goi y markup.

## 4. Luong demo nen dung trong workshop

1. BD/Sales tao Lead tu khach hang tiem nang.
2. Lead co source, customer/contact, service need, POL/POD, expected revenue, follow-up.
3. Bam Create Quotation tu Lead.
4. Chon service, tuyen, container/volume, valid date.
5. Pricing Search Rate/Compare Rates.
6. Chon carrier/agent, apply buying price va phu phi vao charge lines.
7. Sales nhap selling price/markup, VAT, payer/payee.
8. He thong tinh total buying, total selling, VAT amount, profit, profit %.
9. Print/Send quotation cho khach.
10. Khach chap nhan: Confirm/Won va tao Internal Booking/Job cho CS.

## 5. Cau hoi can chot trong workshop

### Cho Pricing

1. Bang gia hien tai nhan tu carrier/agent theo format nao? Excel/PDF/email/body email?
2. Co bao nhieu nhom charge chuan can cau hinh ngay trong MVP?
3. Local charge, service charge, commission charge tach bang rieng hay gom trong mot rate/charge master?
4. Quy tac markup/selling price: nhap tay, theo % mac dinh, theo customer, theo lane hay theo sales?
5. Co can approval khi profit am, margin thap, VAT bat thuong, hoac selling thap hon buying?
6. Can luu country regulation/notes theo POD o muc nao: port, country, carrier, agent hay rate line?
7. Gia co multi-currency nhu the nao: dung ty gia ngay bao gia, ngay xac nhan, hay ngay lap hoa don?

### Cho BD / Sales

1. Pipeline cuoi cung nen dung bo ten nao: New/Contacted/Quoted... hay Tim kiem/Gap go/De xuat...?
2. Khi nao mot lead duoc coi la Quoted/Won/Lost?
3. Required fields toi thieu truoc khi gui bao gia la gi?
4. Khach co nhieu contact/PIC thi nguoi nhan bao gia chon nhu the nao?
5. Mau PDF quotation can theo 4 form rieng hay mot template co bien the theo service?
6. Quotation het han co renew/duplicate nhu the nao?
7. Internal Booking can bat buoc field nao de CS khong phai hoi lai?

### Cho giao diem va phan quyen

1. Pricing va BD co cung sua charge line khong, hay Pricing chi nhap buying/rate con Sales nhap selling?
2. Ai duoc thay buying price/profit? Sales, Sales Manager, Pricing, CS, Director?
3. Sau khi quotation da sent/confirmed co khoa sua khong? Neu sua can Request Modify/approval?
4. Can log before/after cho cac truong nao: buying, selling, VAT, payer/payee, carrier, valid date?

## 6. De xuat pham vi MVP cho workshop

Nen chot MVP quanh 5 man hinh/luong:

1. CRM Lead + pipeline BD.
2. Freight Rate master/import co du thong tin pricing can thiet.
3. Quotation form co tab Charges va computed totals.
4. Search Rate/Price Comparison wizard.
5. Confirm quotation -> tao Internal Booking/Job cho CS.

Chua nen day sau trong workshop dau neu thoi gian han che:
- AI Email Reader tao lead tu email.
- OCR bao gia nha cung cap.
- Customer Portal request quote.
- Dashboard KPI chi tiet.
- Approval Request Modify nang cao.

## 7. Rui ro / diem can kiem tra lai

- Cac file Sale goc dang 0 byte, chua doc duoc 4 mau quotation/report customer/sales monthly that.
- Tai lieu co nhieu bo pipeline/trang thai khac nhau, can chot mot bo dung chung.
- Spec cu dung `mtl.quotation`, nhung ghi chu UI hien tai lai nam trong `Freight Management > Quotations`; can chot kien truc tren Odoo: custom model rieng hay ke thua sale.order.
- Price Comparison ban dau co luc bi de xuat ngoai MVP, nhung feedback CS/Pricing dat P0; can chot lai uu tien.
- Can lam ro ranh gioi Pricing, BD/Sales va CS trong viec tao/chot/sua bao gia.
