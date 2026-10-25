# ADR-0021: Hàm formula nhận timezone tường minh

- Trạng thái: Accepted
- Ngày: 2026-09-23
- Sửa: SPEC §9.4; BACKLOG T006 (session timezone UTC); ảnh hưởng S4b

## Bối cảnh

SPEC §9.4 cài các hàm formula khó (`WORKDAY`, `TEXT`, `DATEDIF`…) thành hàm SQL `IMMUTABLE` trong schema `fx`, và dùng chúng để tính computed field `stored`. Nhưng trong PostgreSQL các phép như `timestamptz::date`, `extract(year FROM timestamptz)`, `to_char(timestamptz, …)` phụ thuộc biến session `TimeZone` (và `lc_time`/`DateStyle` với một số định dạng). Hàm được đánh dấu `IMMUTABLE` nhưng thực chất là `STABLE`:

- Cùng một record, tính lại trên hai connection khác timezone sẽ ra hai giá trị khác nhau (vd `YEAR()` của `2026-12-31T20:00Z` là 2026 ở UTC nhưng 2027 ở `Asia/Ho_Chi_Minh`).
- Test tương đương TS/SQL (§9.4) sẽ lúc đúng lúc sai tuỳ môi trường.
- Nếu sau này đánh index trên biểu thức thì index sẽ sai.

## Quyết định

1. Mọi hàm `fx.*` phụ thuộc lịch nhận **timezone IANA làm tham số**. Compiler chèn giá trị này dưới dạng literal parameter lấy từ `options.timezone` của field ngày được tham chiếu, không có thì lấy timezone của org. Ví dụ: `fx.year(ts, tz)` ≡ `extract(year FROM ts AT TIME ZONE tz)`.
2. Hàm `fx.*` **MUST NOT** đọc `TimeZone`, `lc_*`, `DateStyle` của session. Định dạng trong `TEXT`/`FORMAT` dùng pattern do engine định nghĩa (tên tháng/thứ lấy từ bảng hằng theo `locale` truyền vào làm tham số), không dùng `to_char` với `TM` prefix.
3. `TODAY()`/`NOW()` vẫn là `virtual` (§5.9); `TODAY()` biên dịch thành `(now() AT TIME ZONE tz)::date`.
4. Mỗi connection của pool chạy `SET TIME ZONE 'UTC'` làm lớp phòng thủ thứ hai (T006).
5. Đổi timezone của org hoặc của field ngày → job backfill mọi computed field `stored` có phụ thuộc (dựa trên `meta.field_dependencies`).
6. Test tương đương chạy harness SQL hai lần với `TimeZone` = `UTC` và `Pacific/Kiritimati` (+14); kết quả phải giống hệt nhau.

## Hệ quả

- Chữ ký hàm trong `packages/formula-engine/functions/<NAME>.ts` có thêm tham số ngữ cảnh `{ timezone, locale }` cho cả TS evaluator và SQL compiler.
- Kết quả `stored` xác định, index được, và giống preview trên client.
