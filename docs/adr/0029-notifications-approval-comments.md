# ADR-0029: Thông báo, phê duyệt và bình luận trên record

- Trạng thái: Accepted
- Ngày: 2026-09-24
- Sửa: SPEC §1 (phạm vi), §5.5 (`user.notify_on_assign`), §5.10, §11.2, §11.5, §14.4, §15, §22 (thêm S5b, S10, S11); CONTRACTS §6 (dành sẵn `RECORD_LOCKED`). Nguồn: `docs/reviews/lark-gap-analysis.md` §4 và §5 câu 1–4.
- Làm rõ bởi: ADR-0034 (S5b — lõi quét thời gian dùng chung, gom `record.assigned`/`record.followed_changed` qua bộ đệm `meta.notification_buffer` + `notifications.flush`, kênh Telegram qua bot của org); nội dung đã Accepted ở dưới không sửa.

## Bối cảnh

SPEC có sẵn event, worker, audit, realtime kênh `user:{id}`, nhưng chưa có nơi nào gửi thông báo cho người dùng. `notify_on_assign` của field `user` (§5.5) và "gửi thông báo cho người tạo" của circuit breaker (§11.6) không có hạ tầng đi kèm. Phê duyệt (§11.5 Phase 2) và comment/mention (§1 "Không làm trong MVP") là hai khoảng trống lớn nhất khi so với Lark.

Lark không có node phê duyệt trong Base. Họ dùng flow field, nút trên message card, hoặc đồng bộ từ app Approval riêng. Lark Approval (app riêng) có: người duyệt theo quản lý/phòng ban/nhóm/người chỉ định/người gửi, any/all/tuần tự, trả lại, CC, quyền field theo bước. Chi tiết và nguồn trong ghi chú nghiên cứu phê duyệt/cộng tác (Lark HC 360041315273, 680083197034, 034635082486; Feishu HC 127551385673, 360049067920).

Quyết định của người review (gap analysis §5):

- Câu 2: quyền comment đi theo quyền đọc.
- Câu 3: xem lịch sử record vẫn cần quyền đọc (không đổi sang quyền sửa như Lark).
- Câu 4: chưa làm sơ đồ tổ chức. Người duyệt chọn theo user, group, field user, hoặc người gửi.

## Quyết định

### 1. Hạ tầng thông báo (S5b)

```sql
meta.notifications(id 'ntf_', organization_id, user_id, type, base_id NULL, table_id NULL,
  entity_type, entity_id, actor_type NULL, actor_id NULL, group_key NULL,
  payload jsonb,              -- chỉ id + tham số dạng lưu trữ, không chứa giá trị record
  read_at NULL, created_at)
  -- index (organization_id, user_id, read_at, created_at DESC); dọn sau NOTIFICATION_RETENTION_DAYS (mặc định 90)
meta.notification_preferences(organization_id, user_id, type, channel, enabled,
  PK(organization_id, user_id, type, channel))   -- không có dòng = mặc định của type
meta.user_channels(id 'uch_', organization_id, user_id, kind, address_enc, verified_at NULL)
  -- kind: telegram (chat_id mã hoá như meta.secrets)
meta.record_follows(organization_id, table_id, record_id, user_id, created_at, PK(table_id, record_id, user_id))
```

- **Loại thông báo** (danh mục đóng, zod enum; thêm = sửa CONTRACTS): `record.assigned` (field `user` có `notify_on_assign`), `record.followed_changed`, `date.reminder`, `automation.disabled`, `automation.batch_overflow`, `import.finished`. Từ S10: `approval.task_assigned`, `approval.reminder`, `approval.completed`, `approval.cc`. Từ S11: `comment.mentioned`, `comment.replied`.
- **Kênh**: `in_app` (luôn có, không tắt được với `approval.task_assigned` và `automation.disabled`), `email` (khi org có SMTP), `telegram` (khi org cấu hình bot, secret trong `meta.secrets`). Người dùng liên kết Telegram bằng deep link `t.me/<bot>?start=<code một lần, 10 phút>`. Worker đọc `getUpdates` (long polling, chỉ chạy khi org bật Telegram), không cần URL public. Chế độ webhook của Telegram để Phase 2.
- **Luồng**:
  - Mutation ghi event (C§8), `events.dispatch` enqueue job `notifications.fanout`.
  - Job tính người nhận và kiểm quyền **từng người nhận tại thời điểm gửi**: đọc được record, và đọc được field với `record.followed_changed`/`date.reminder`. Không đủ quyền thì bỏ, không lộ gì.
  - Job ghi `meta.notifications` rồi `afterCommit` publish envelope `notification.created` tới `user:{id}`.
  - Email và Telegram gửi qua job `notifications.deliver` (idempotency `ntf_id:channel`), gom theo người nhận mỗi 5 phút (digest) trừ `approval.task_assigned`.
- **Nội dung**: in-app chỉ lưu id. Tiêu đề record được render lúc đọc qua API có kiểm quyền. Email/Telegram chỉ chứa primary field của record (nếu người nhận đọc được) và link `<PUBLIC_URL>/…`. Không có giá trị field khác, không token đăng nhập một chạm.
- **Không báo cho chính người gây ra thay đổi.** Thay đổi hàng loạt theo định nghĩa ADR-0026 mục 2:
  - `record.followed_changed`: không gửi (giống Lark);
  - `record.assigned`: gom thành một thông báo mỗi người nhận mỗi `batch.id` ("được gán 37 record", `group_key = batch.id`).
- **Follow record**: `PUT|DELETE /api/v1/tables/:id/records/:recordId/follow`. Cần quyền đọc record. Thay đổi do automation/API cũng được báo; đổi kiểu hoặc xoá field thì không.
- **Nhắc hạn field ngày**: `options.reminder` trên field `datetime` (`{ offset_minutes, time_of_day (cho field chỉ ngày, mặc định 09:00 theo timezone field), recipients: "field_user" | "users", user_field_id | user_ids }`). Dùng chung bộ quét thời gian với trigger `record.date_reached` (SPEC §11.2). Mỗi (record, field, giá trị) nhắc một lần.
- **API** (chi tiết ở CONTRACTS khi làm S5b): `GET /api/v1/me/notifications` (cursor, `unread`), `POST /api/v1/me/notifications/read` (`ids` hoặc `all`), `GET|PUT /api/v1/me/notification-preferences`, `POST|DELETE /api/v1/me/channels/telegram`.

### 2. Phê duyệt (S10)

```sql
meta.approval_flows(id 'apf_', organization_id, base_id, table_id, name, enabled, version,
  definition jsonb, lock_record bool, created_by, deleted_at)
meta.approval_instances(id 'apr_', organization_id, base_id, table_id, record_id, flow_id, flow_version,
  definition_snapshot jsonb, status, current_step_id NULL, requester_id, started_at, finished_at NULL,
  trigger_event_id NULL, automation_run_id NULL, version,
  UNIQUE (flow_id, record_id) WHERE status = 'running')
  -- status: running | approved | rejected | withdrawn | cancelled
meta.approval_tasks(id 'apt_', organization_id, instance_id, step_id, assignee_id, status,
  decided_at NULL, comment NULL, due_at NULL)
  -- status: pending | approved | rejected | returned | skipped | cancelled; index (organization_id, assignee_id, status)
meta.approval_ccs(organization_id, instance_id, step_id, user_id, read_at NULL, PK(instance_id, step_id, user_id))
```

- **Định nghĩa flow** (zod trong `packages/contracts`). `steps[]` tuyến tính, mỗi bước gồm:
  - `id`, `name`;
  - `when` (Filter DSL, tuỳ chọn: bước bị bỏ qua nếu record không khớp; đây là cách làm nhánh, không có đồ thị nhánh);
  - `approvers`, `mode: any | all`;
  - `on_empty: skip | reject | admin` (không tìm được người duyệt);
  - `on_self: approve | skip | keep` (người duyệt trùng người gửi);
  - `editable_fields[]`, `required_fields[]`;
  - `allow_return`, `comment_required_on_reject`;
  - `cc`;
  - `sla_hours` (nhắc, không tự quyết).

  Mức flow: `on_approved`/`on_rejected` `set_fields` (giá trị theo §11.4) và `lock_record`.
- **Nguồn người duyệt** (câu 4): `{ source: "users", user_ids }`, `{ source: "group", group_id }`, `{ source: "field", field_id }` (field `user` của record, hoặc lookup có kết quả là user), `{ source: "requester" }`. **Không** có quản lý/phòng ban/sơ đồ tổ chức. Muốn duyệt theo cấp quản lý thì tự dựng bảng Nhân sự (cột "Quản lý" kiểu `user`) rồi dùng lookup từ record sang bảng đó. Người duyệt phải đọc được record lúc giao việc; không đọc được thì bị loại, và nếu bước không còn ai thì áp `on_empty`.
- **Khởi tạo**:
  - Nút "Gửi duyệt": `POST /api/v1/tables/:id/records/:recordId/approvals { flow_id }`. Cần quyền **sửa** record; người gửi là người gọi.
  - Action automation `start_approval` (`flow_id`, `requester`: mặc định `run_as` (ADR-0025) hoặc `{ field }`). Quyền kiểm theo `run_as`.
  - Record đã có instance `running` của flow đó → `422 VALIDATION_FAILED` với `errors[].code = APPROVAL_RUNNING`.
- **Quyết định**: `POST /api/v1/approval-tasks/:id/decide { decision: approve | reject | return, comment?, return_to_step_id?, fields?, instance_version }`.
  - Chỉ assignee của task `pending`. Không phải assignee nhưng đọc được record → `403`; không đọc được → `404`.
  - Ghi `fields` (chỉ `editable_fields` của bước) qua `RecordMutationService`, `via = { approval_instance_id, approval_task_id }`.
  - `mode: any`: một người duyệt là xong bước, các task còn lại `cancelled`. `all`: cần mọi người duyệt; một người từ chối là bước bị từ chối.
  - `return` đưa instance về bước đã qua (mặc định bước ngay trước). Bước đó và các bước sau tạo task mới.
- **Rút đơn và huỷ**: người gửi rút được khi instance còn `running` (`withdrawn`). Base admin huỷ được (`cancelled`), có audit. Chuyển người duyệt, thêm người duyệt, duyệt hàng loạt, chữ ký: sau S10.
- **Khoá record** (`lock_record = true`, mặc định true): khi instance `running`, `RecordMutationService` từ chối mọi sửa/xoá record đó → `409 RECORD_LOCKED` (trong bulk: `errors[].code = RECORD_LOCKED` theo record). Áp cho mọi nguồn ghi: user, API token, automation, import upsert. Ngoại lệ duy nhất:
  - assignee đang có task `pending` sửa `editable_fields` của bước hiện tại;
  - chính engine phê duyệt ghi `set_fields`.

  Admin muốn sửa thì phải huỷ instance trước. Kiểm tra bằng đọc `approval_instances` trong cùng transaction ghi (khoá dòng instance `FOR SHARE`), không dùng lock DB dài hạn. Liên kết từ phía bảng khác (link hai chiều) vẫn ghi được vì không sửa ô của record bị khoá.
- **Automation**: trigger `approval.completed` (config `flow_id`, `outcome: approved | rejected | withdrawn | any`). Record của trigger là record của instance. Dữ liệu duyệt tham chiếu bằng `{ "trigger": "approval", "path": "outcome" | "requester_id" | "instance_id" }` (§11.4). Event `approval.started|step_decided|completed|cancelled` có `causation`, nên loop guard áp như thường.
- **Audit**: `approval.started|decided|returned|withdrawn|cancelled|completed`, `entity_type = approval_instance`, `table_id` + `entity` record kèm trong `after`. Tab Lịch sử của record hiển thị các mục này chung timeline với thay đổi field (lọc theo quyền đọc record, câu 3).
- **Realtime**: envelope `approval.changed` tới `table:{id}` (badge trạng thái trên dòng, lọc theo quyền đọc record như `record.changes`) và `user:{id}` (hộp "Chờ tôi duyệt").
- **UI**: tab "Phê duyệt" trong panel record; trang "Hộp duyệt" (chờ tôi, tôi đã gửi, CC tôi); trình dựng flow dạng danh sách bước. i18n `en` + `vi`.

### 3. Bình luận record (S11)

```sql
meta.record_comments(id 'cmt_', organization_id, base_id, table_id, record_id, parent_id NULL,
  author_id, body jsonb, edited_at NULL, resolved_at NULL, resolved_by NULL, deleted_at NULL, created_at)
  -- body: { text, mentions: [usr_…] }; thread một cấp (reply của reply gắn vào gốc)
meta.comment_reactions(organization_id, comment_id, user_id, emoji, PK(comment_id, user_id, emoji))
```

- **Quyền** (câu 2): đọc được record thì đọc, đăng, reply, reaction, resolve và mở lại comment. Sửa/xoá: chỉ comment của mình. Base admin và `manage` trên table xoá được mọi comment. Không có quyền `comment` riêng trong role. Người xem qua share link không thấy comment.
- **@mention**: chỉ gợi ý người đọc được record. Người được nhắc không đọc được record (hoặc mất quyền sau đó) thì không nhận thông báo. UI cảnh báo lúc gõ, server không trả lỗi để không lộ quyền của người khác. Thông báo: `comment.mentioned` cho người được nhắc, `comment.replied` cho người tham gia thread và người follow record.
- **Record bị xoá mềm**: comment giữ nguyên, purge cùng record. Comment không nằm trong record history (tab riêng). Audit ghi `comment.created|updated|deleted|resolved` chỉ với id, không lưu nội dung.
- **Realtime**: envelope `comment.changed` tới `table:{id}` (đếm comment trên dòng) và tới người đang mở panel record, lọc theo quyền đọc record.
- **Gói `.chbase`** (ADR-0024): S11 thêm `comments.jsonl` (tuỳ chọn khi xuất), tăng `format_version`.

### 4. Không đổi

Lịch sử record vẫn cần quyền đọc record hiện tại và lọc field theo quyền hiện tại (ADR-0023, câu 3).

## Phương án đã cân nhắc

- **Flow field kiểu Lark thay cho approval**: nhẹ nhưng không có any/all, CC, trả lại, khoá record. Có thể thêm sau như một field `stage`, không thay approval.
- **Phê duyệt bằng automation + nút trong tin nhắn**: cần link hành động có ký cho email/Telegram (rủi ro bảo mật, để sau S10). Không có hộp duyệt và khoá record.
- **Đồ thị nhánh/song song như Lark Approval**: quá lớn cho một sprint. `when` trên từng bước đủ cho đa số luồng (ví dụ: "> 50 triệu thì thêm bước giám đốc").
- **Quyền `comment` riêng trong role**: thêm một chiều cấu hình cho mọi role mà giá trị thực tế nhỏ. Bị loại theo câu 2.
- **Sơ đồ tổ chức (quản lý, phòng ban)**: cần mô hình người dùng mới và đồng bộ HR/OIDC. Để sau theo câu 4.

## Hệ quả

- Thêm sprint S5b (thông báo, sau S5), S10 (phê duyệt) và S11 (bình luận) vào SPEC §22. S10, S11 thuộc v0.2 (sau release v0.1.0 ở S9).
- Prefix id mới `ntf`, `uch`, `apf`, `apr`, `apt`, `cmt`, cùng các loại event, audit action, envelope realtime ở trên được thêm vào CONTRACTS (§1.2, §7, §8) trong sprint cài đặt, cùng lúc với zod.
- `409 RECORD_LOCKED` được dành sẵn trong CONTRACTS §6 ngay từ bây giờ, để S4–S9 không dùng mã này cho việc khác.
- `RecordMutationService` phải có điểm kiểm tra khoá record (S10). Mọi đường ghi đã đi qua service này (quy tắc vàng 1), nên không có đường vòng.
