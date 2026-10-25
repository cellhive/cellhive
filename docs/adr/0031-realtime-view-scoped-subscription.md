# ADR-0031: Subscription `table:` theo view đang mở

- Trạng thái: Accepted
- Ngày: 2026-09-25
- Thay thế / sửa: CONTRACTS §7 (`subscribe`, `error`, bảng message record), FRONTEND §5, §6.6; bổ sung T210/T303 (SPEC §15)

## Bối cảnh

T210 lọc message record theo quyền của subscriber (read rule + field perm) ở mức **table**. Grid/kanban luôn đọc qua view (T302): filter đã lưu của view — kể cả điều kiện trên field người xem không đọc được (Quyết định S3 #3) — cộng filter tạm và search của người xem (T311). Hệ quả: pill "N dòng mới" đếm mọi `record.created` của table; `record.added`/`removed_from_view` chỉ phản ánh read rule. Trường hợp không thể sửa ở client: view Sales lọc `cost > 50`, u_sales1 không đọc được `cost`; admin sửa `cost` làm r1 rời view → theo P23 u_sales1 **không nhận gì** (không field thấy được nào đổi), dòng đứng yên sai mãi tới lần refetch.

## Quyết định

1. **`subscribe` mang view.** `{ "type": "subscribe", "channel": "table:tbl_…", "req_id": "…", "view": { "id": "viw_…", "filter_mode": "and" | "replace" } }` (`view` chỉ với kênh `table:`, khác → `VALIDATION_FAILED` / `NOT_ALLOWED` path `view`). Không thêm kênh `view:`: một subscription/kênh/kết nối như cũ; subscribe lại cùng kênh với view khác = thay scope (không có khoảng trống message).
2. **Server đánh giá view.** View được kiểm như `view_id` của `records/query` (thấy table ∩ `visible_views` hoặc view cá nhân của mình). Với subscription có view, "đọc được" trong bảng T210 = read rule **AND** filter đã lưu của view (`filter_mode = and`), hoặc chỉ **phần ẩn** với subscriber (`replace`, cùng định nghĩa C§1.4/§15), giải biến `current_user`/`current_user_groups`/`$date` theo subscriber, điều kiện không còn validate bị bỏ qua như query. Bảng created/updated/added/removed_from_view/deleted/restored, P22/P23, `record.batch` giữ nguyên, chỉ thay "phạm vi đọc" bằng "phạm vi view". Nhóm subscriber theo (quyền, view filter áp dụng).
3. **Ảnh record mang field của filter view.** `RecordRuleFields` thêm field được nêu trong filter đã lưu của mọi view của table (đọc mỗi lần ghi, một truy vấn theo index), để server đánh giá được mà không đọc DB khi phân phối.
4. **View đổi → nạp lại trước envelope kế tiếp.** Router nhận `schema.changed` entity `view` thì kiểm lại (cùng hàng đợi theo org) mọi subscription dùng view đó; `permission.changed` cũng kiểm lại view. View bị xoá/ẩn → gỡ subscription + `{ "type": "error", "code": "NOT_FOUND", "channel", "view_id" }` (có `view_id` = table vẫn đọc được, chỉ view mất).
5. **Phần client tự kiểm.** Filter tạm và search chỉ dùng field người xem đọc được, nên mọi thay đổi liên quan đều tới client dưới dạng `record.updated` có field đó. Client kiểm bằng `POST …/records/query { ids, view_id, filter, filter_mode, search }` (server đánh giá, không đoán ở client): `record.created` (khi có filter tạm/search) và `record.updated` chạm field của filter tạm/primary (khi search). Không kiểm được (request lỗi) hoặc khoá sort/group của dòng đang hiển thị bị người khác sửa → pill "Dữ liệu đã thay đổi — làm mới" thay vì số sai.

## Phương án đã cân nhắc

- **Client tự đánh giá filter view**: không làm được khi view có điều kiện ẩn (client không có giá trị `cost`, và không được có); còn làm lệch ngữ nghĩa SQL ↔ JS.
- **Client kiểm lại mọi `record.updated` qua `ids`**: vẫn không biết thay đổi trên field ẩn (không có message nào), và nhân số request.
- **Gửi filter tạm/search lên server trong `subscribe`**: search (ILIKE/unaccent trên primary) không đánh giá rẻ bằng evaluator; filter tạm chỉ trên field thấy được nên client kiểm chính xác bằng `ids`. Giữ message client nhỏ (≤ 16 KiB) và server không cần validate filter người dùng trên đường realtime.
- **Kênh `view:{id}`**: nhân đôi subscription (grid vẫn cần `table:` cho schema/record ngoài view), phá giới hạn 50 kênh; không cần.

## Hệ quả

- Mỗi lần ghi record thêm một truy vấn `meta.views` theo `(organization_id, table_id)` khi realtime bật; ảnh record lớn hơn theo số field trong filter view.
- Subscriber có view nhận ít message hơn (record ngoài view không gửi gì) → pill đếm đúng view; không bao giờ lộ id record ngoài read rule hoặc ngoài điều kiện ẩn (record ngoài view cả trước lẫn sau → không gửi gì).
- Record ngoài view mở ở panel (deep link) không nhận `record.updated` qua kênh này; panel vẫn refetch khi `record.batch`/nối lại.
- Một kênh một scope/tab: màn hình không view (thùng rác) cùng lúc với grid dùng view của grid (không xảy ra ở route hiện tại).
