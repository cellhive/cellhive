# ADR-0025: Automation chạy bằng quyền của người bật/sửa cuối (`run_as`)

- Trạng thái: Accepted
- Ngày: 2026-09-24
- Sửa: SPEC §5.10 (`meta.automations`), §11.1, §11.6, §13.3, §14.1 mục 5; CONTRACTS §5 (P29, thêm P31–P33). Nguồn: `docs/reviews/lark-gap-analysis.md` A1.

## Bối cảnh

SPEC §14.1 mục 5 cho automation chạy bằng quyền của **người tạo** (`created_by`). Người có quyền quản lý automation (base admin, hoặc `manage` trên table) sửa được automation do người khác tạo. Hệ quả: user có `manage` trên một table sửa automation do org admin tạo, thêm `update_record` vào table mà chính họ không có quyền, và automation vẫn chạy bằng quyền admin. Đây là leo thang quyền.

Lark gắn automation với **người bật/người cấu hình** ("the user who activated this workflow"). Người đó mất quyền thì automation chuyển cho owner base hoặc dừng và báo owner (Feishu HC 348126593171, Lark HC 360048488445).

Ngoài ra, khi người tạo mất quyền, SPEC hiện để run fail `permission_denied` cho tới khi đủ 50 lần fail liên tiếp mới ngắt mạch, và chỉ báo cho người tạo (người đã mất quyền).

## Quyết định

1. **`run_as`**. `meta.automations` thêm `run_as_user_id` (NOT NULL) và `run_as_since`. `created_by` giữ nguyên, chỉ để hiển thị và audit. Mọi action (đọc qua `RecordQueryService`, ghi qua `RecordMutationService`, payload `http_request`/`run_n8n_workflow` §13.3) dùng quyền hiệu lực của `run_as_user_id` tại **thời điểm chạy** (resolve theo `permission_version` hiện tại, không cache từ lúc lưu). Audit của mutation vẫn ghi `actor_type = automation`, `via = { automation_id, run_id }`.
2. **Chuyển `run_as`**. `run_as` chuyển sang người thực hiện khi:
   - sửa `definition` (trigger, condition, action, tuỳ chọn như `skip_bulk`);
   - bật automation (`POST /automations/:id/enable`);
   - bấm "Nhận quản lý" (take over, mục 6).

   Đổi tên, mô tả, hoặc **tắt** automation không đổi `run_as`. Tạo mới: `run_as` = người tạo.
3. **Kiểm quyền khi lưu**. Người sửa phải quản lý được automation (base admin, hoặc `manage` trên table của trigger) **và** định nghĩa phải hợp lệ với quyền của chính họ: đọc được table/field được tham chiếu, có quyền ghi tương ứng với action ghi (`perm ≥ edit`, `add`/`delete` khi cần, field `edit`/`create`). Thiếu quyền → `422 AUTOMATION_INVALID` với `errors[].path` chỉ action và `code = PERMISSION_DENIED`; table/field không đọc được thì báo như không tồn tại (`UNKNOWN_TABLE`/`UNKNOWN_FIELD`), không lộ sự tồn tại.
4. **UI cảnh báo**. Khi người đang sửa khác `run_as` hiện tại, trình dựng hiển thị trước khi lưu: "Sau khi lưu, automation sẽ chạy bằng quyền của bạn thay cho <tên>". Chuỗi qua i18n `en` + `vi`.
5. **`run_as` mất quyền → tắt ngay**. "Mất quyền" là một trong các trường hợp: không còn là member org hoặc bị vô hiệu hoá; không còn quản lý được automation đó (mục 3); định nghĩa không còn hợp lệ với quyền của `run_as` (mục 3).
   - Phát hiện ở hai nơi. (a) Job `automation.revalidate_run_as` được enqueue cùng transaction với mọi lần tăng `permission_version` của base, gỡ thành viên org, vô hiệu hoá user. Job kiểm tra mọi automation đang bật của các base liên quan. (b) Khi chạy: action gặp lỗi quyền → run `failed` (`permission_denied`) và enqueue ngay job kiểm tra trên. Lỗi chỉ ở mức record (record nằm ngoài `edit_filter` của `run_as`) **không** phải mất quyền: automation vẫn bật, run lỗi được tính vào circuit breaker (ADR-0026).
   - Khi phát hiện: `enabled = false`, `disabled_reason = 'run_as_lost_access'`. Run đang `queued`/`waiting` của automation chuyển `cancelled`. Run đang `running` dừng ở step lỗi với status `failed`, `error.code = 'permission_denied'`. Không chờ đủ 50 lần fail.
   - Thông báo cho **owner base + mọi base admin** (không chỉ `run_as`). Trước S5b: hiển thị trong danh sách automation + email nếu org có SMTP. Từ S5b: qua hạ tầng thông báo (ADR-0029), loại `automation.disabled`.
6. **Nhận quản lý (take over)**. `POST /api/v1/automations/:id/take-over` với body `{ "enable": boolean }`, dành cho người quản lý được automation. Kiểm quyền như mục 3 với người gọi, đặt `run_as` = người gọi, bật lại nếu `enable = true`. Không tự chuyển cho owner base như Lark, vì như vậy automation lặng lẽ chạy bằng quyền cao hơn mà không ai xác nhận.
7. **Audit và event**. Thêm `automation.run_as_changed` (`before.run_as_user_id`, `after.run_as_user_id`, `after.reason`: `created | edited | enabled | taken_over`) vào danh mục C§8 khi cài ở S5. `automation.disabled` giữ nguyên, `after.disabled_reason` nhận thêm giá trị `run_as_lost_access`.
8. **Danh tính gửi**. `send_email`/`send_telegram` dùng cấu hình SMTP và bot của org (`meta.secrets`), không gửi dưới danh nghĩa cá nhân `run_as`. Vì vậy đổi `run_as` không đổi người gửi.
   *Ghi chú 2026-10-05 (T513)*: "cấu hình SMTP của org" được làm rõ bởi BACKLOG "Quyết định S5" #1 và ADR-0033 — S5 gửi qua SMTP cấp instance hoặc SMTP của danh tính gửi đã xác minh; SMTP cấp org là P1. Ý chính (không gửi dưới danh nghĩa `run_as`) giữ nguyên.

## Phương án đã cân nhắc

- **Giữ `created_by`**: đơn giản, nhưng chính là lỗ hổng leo thang quyền ở trên.
- **Chạy bằng "bot hệ thống" toàn quyền base** (như bot Base của Lark): dễ dùng nhưng biến quyền `manage` automation thành toàn quyền dữ liệu, trái với mô hình role ở §14.1.
- **Tự chuyển `run_as` cho owner base khi mất quyền** (giống Lark): tránh gián đoạn, nhưng là nâng quyền ngầm. Chọn tắt + báo + take over có xác nhận.
- **Chỉ chuyển `run_as` khi bật, không chuyển khi sửa**: vẫn cho người sửa lợi dụng quyền của người bật trước đó. Bị loại.

## Hệ quả

- Migration S5: thêm `run_as_user_id`, `run_as_since` vào `meta.automations` (chưa có dữ liệu, không cần backfill).
- Ma trận C§5: P29 đổi thành "automation có `run_as` = u_sales1" (lỗi theo record không tắt automation); thêm P31 (u_editor không sửa được automation), P32 (người sửa trở thành `run_as`, không leo thang được), P33 (`run_as` bị gỡ role → automation tắt ngay, admin được báo, take over).
- Người sửa automation của người khác cần được nhắc rõ bằng UI: automation có thể ngừng chạy đúng như trước nếu người sửa có ít quyền hơn.
