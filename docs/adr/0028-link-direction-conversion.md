# ADR-0028: Cho phép đổi link một chiều ↔ hai chiều; tối đa 500 liên kết mỗi ô

- Trạng thái: Accepted
- Ngày: 2026-09-24
- Sửa: SPEC §5.5 (đổi kiểu field), §5.6; CONTRACTS §4.2, §4.4. Nguồn: `docs/reviews/lark-gap-analysis.md` §4 và §5 câu 5.

## Bối cảnh

SPEC §5.6 cấm đổi `bidirectional` sau khi tạo. Người dùng tạo link một chiều rồi mới cần xem ngược từ bảng kia (ví dụ: Khách hàng → các Đơn hàng) phải xoá field và nối lại toàn bộ dữ liệu. Lark cho đổi cả hai chiều: two-way → one-way thì field bên kia bị xoá, dữ liệu phía này giữ; one-way → two-way thì tạo field ngược kèm liên kết (Lark HC về field link hai chiều; giới hạn 500 link/ô: https://www.larksuite.com/hc/en-US/articles/890398616778).

Mô hình lưu trữ của Cellhive làm việc này rẻ. Hai phía của link hai chiều dùng **chung** junction `data.l_<fld>` (`a_id`, `b_id`, `position`), nên đổi chiều không phải chép dữ liệu, chỉ thêm hoặc bớt field meta đọc theo chiều ngược.

SPEC cũng chưa có giới hạn số liên kết mỗi ô. Lark giới hạn 500 link/ô. Một ô không giới hạn làm payload record, realtime và lookup phình to không kiểm soát.

## Quyết định

1. **One-way → two-way**. Field `link` ở bảng A (junction side `a`) chuyển `bidirectional: true` bằng luồng đổi kiểu §5.5: `POST /fields/:id/convert-preview` rồi `PUT /fields/:id` → `202 { job_id }`.
   - Body: `bidirectional_link_field_name` (bắt buộc, `409 NAME_CONFLICT` nếu trùng ở bảng B).
   - Người gọi cần quyền sửa schema ở **cả hai** bảng (base admin, hoặc `manage` trên A và B). Không đọc được B → `404`.
   - Job `field.convert` (named queue `schema:<tableId>` của bảng A, ADR-18), trong một transaction của `SchemaService`: tạo field ngược ở B (`symmetric_field_id` trỏ nhau, dùng chung junction, không tốn slot cột vật lý của ngân sách §5.4 nhưng tính vào `MAX_FIELDS_PER_TABLE` → `422 FIELD_LIMIT_EXCEEDED`), phát `field.created` + `schema.changed`, audit. Field ngược luôn được tạo với `allow_multiple = true`. Muốn chuyển sang một record thì dùng luồng cắt dữ liệu §4.2 như với link thường.
   - Không sinh event `record.updated` cho record ở B, vì dữ liệu không đổi. Lịch sử record của B chỉ có mục từ lúc chuyển trở đi.
   - Self-link: áp cùng quy tắc như khi tạo link hai chiều tự tham chiếu.
2. **Two-way → one-way**. Chọn giữ phía nào thì gọi đổi kiểu trên field đó với `bidirectional: false`. Field phía kia bị **xoá mềm** theo quy tắc xoá field (§5.5, khôi phục được 30 ngày). Junction giữ nguyên. Đây chính là hành vi "xoá một phía → phía còn lại thành một chiều" đã có, nay đi qua luồng đổi kiểu để có preview.
   - Preview trả danh sách phụ thuộc sẽ hỏng ở phía bị xoá: formula, lookup, filter của view, field trong role config, automation tham chiếu field đó.
   - Job tính lại các computed field phụ thuộc theo §5.9, theo lô 5.000 dòng. Giá trị của chúng thành lỗi như khi field bị xoá.
   - `POST /fields/:id/revert-conversion` trong 7 ngày khôi phục field phía kia (cùng id) nếu nó chưa bị purge. Tương đương `POST /fields/:otherId/restore`.
3. **Trạng thái khi đang chạy job**. Cả hai bảng ở `schema_state` khoá cho field liên quan: sửa schema field đó → `409 SCHEMA_LOCKED`. Ghi record vẫn được, vì junction không đổi cấu trúc.
4. **Giới hạn 500 liên kết mỗi ô**, áp cho **mỗi phía** của link, kể cả phía ngược của link hai chiều. Hằng số `LINK_MAX_PER_CELL = 500` trong `packages/field-types`.
   - Ghi làm một ô vượt 500 → `422 INVALID_CELL_VALUE` với `errors[].code = TOO_MANY_VALUES`, `params.limit = 500`. Với phía ngược, ô bị vượt là ô ở bảng kia, `path` chỉ record gây vượt.
   - Dữ liệu có sẵn đã vượt (chỉ xảy ra ở phía ngược vừa được tạo khi chuyển one-way → two-way) được giữ nguyên. Preview trả `over_limit` (số ô) + mẫu. Các ô đó chỉ gỡ được liên kết, không thêm được, cho tới khi ≤ 500.
   - Đọc record không cắt ô. Grid hiển thị tối đa 500 chip kèm "+N".

## Phương án đã cân nhắc

- **Giữ lệnh cấm**: người dùng phải tự xoá field rồi nối lại, dễ mất dữ liệu. Lark đã cho làm.
- **Chép junction sang bảng mới khi đổi chiều**: không cần, vì hai phía vốn dùng chung junction.
- **Cắt dữ liệu vượt 500 khi chuyển chiều**: mất liên kết mà người dùng không yêu cầu. Chọn giữ và chặn thêm.

## Hệ quả

- Task link của S4 cài cả hai chiều chuyển đổi và giới hạn 500 ngay từ đầu, trước khi có dữ liệu thật.
- CONTRACTS §4: link giữa kiểu khác vẫn nằm trong blacklist; riêng đổi `bidirectional` trong cùng kiểu `link` được phép theo ADR này.
- Bench §21 (2 link/bảng, 200k dòng) thêm một trường hợp ô 500 liên kết để đo payload và lookup.

## Ghi chú triển khai (T404, ghi lại ở T422)

- Chi tiết định dạng ở CONTRACTS §4.1/§4.2/§4.4 (`link_change`: `to_two_way`, `to_one_way`, `to_single`), khớp code. Field ngược tạo ở mục 1 có `record_filter = null`; nếu junction còn field phía kia trong thùng rác (sau một lần hai → một chiều) thì field đó được lấy lại thay vì tạo mới.
- `allow_multiple` true → false (`to_single`) cũng đi qua luồng này: mỗi ô giữ liên kết đầu tiên, liên kết bị gỡ được chép vào bảng sao lưu `l_<fld>__old_<ms>` để hoàn tác 7 ngày, một dòng audit mỗi record bị cắt, không có event record (Câu hỏi mở S4 #7).
- Mục 2 "Job tính lại các computed field phụ thuộc": S4 chưa có formula/lookup nên job không có gì để tính lại; S4b (lookup trên link, `#REF` khi field link bị xoá) phải nối vào đúng chỗ này.
