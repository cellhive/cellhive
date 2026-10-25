# ADR-0023: Audit log và lịch sử record

- Trạng thái: Accepted
- Ngày: 2026-09-23
- Sửa: SPEC §5.4, §5.5, §5.10, §13.1, §14.2, thêm §14.4; CONTRACTS §1.2, thêm §11; BACKLOG T006, T107, T108, thêm T111
- Cập nhật: T403 (§3 hoàn tác đổi kiểu, lịch sử qua đổi kiểu), T422 (§2 độ chi tiết audit của xoá cứng), T465 (§4 lịch sử và hoàn tác link/`parent`), T709 (§4 `audit.viewed` thưa theo bộ lọc, 10 phút)

## Bối cảnh

SPEC v1.2 đã có `meta.audit_logs` (ghi cùng transaction, `before`/`after` chỉ các field thay đổi) và endpoint lịch sử record. Nhưng chưa trả lời được các câu hỏi người dùng hay hỏi nhất: "ai xoá dòng này", "ô này ai sửa, lúc nào, từ giá trị gì", "đợt dán 500 ô vừa rồi là của ai". Còn thiếu:

1. Không có `__deleted_by` → thùng rác không biết ai xoá.
2. Thao tác hàng loạt không được gom nhóm.
3. Không biết nguồn cụ thể (automation/run nào, API token nào, share link/form nào, job import nào).
4. Xoá field hoặc đổi kiểu làm mất cả cột dữ liệu, nhưng chưa có API khôi phục.
5. Xem lịch sử có thể lộ giá trị của field mà người xem không có quyền.
6. Chưa có thời hạn lưu, chưa chống sửa log, chưa xử lý yêu cầu xoá dữ liệu cá nhân.

## Quyết định

### 1. Mô hình dữ liệu

```sql
meta.audit_logs(
  id, organization_id NULL, base_id NULL, table_id NULL,   -- NULL chỉ với auth.* chưa rõ org và lệnh CLI (CONTRACTS §8)
  actor_type, actor_id,            -- user | api_token | automation | share_link | system
  via jsonb NULL,                  -- { automation_id, run_id } | { api_token_id } | { share_link_id } | { import_job_id }
  action,                          -- vd record.updated, field.deleted, role.updated, export.created
  entity_type, entity_id,
  batch_id NULL,                   -- req_… (một request) hoặc job_… (một job nền)
  request_id NULL,
  before jsonb, after jsonb,
  ip, user_agent, created_at,
  PK(id, created_at)
)  -- partition theo tháng
INDEX (organization_id, entity_type, entity_id, created_at DESC)
INDEX (organization_id, table_id, created_at DESC)
INDEX (organization_id, batch_id) WHERE batch_id IS NOT NULL
```

- Mỗi bảng dữ liệu thêm cột hệ thống `__deleted_by text` (ai đưa vào thùng rác).
- `id` có prefix `aud_`.

### 2. Ghi gì cho record

| Thao tác | Số dòng audit | `before` / `after` |
|---|---|---|
| Tạo | 1 / record | `null` / mọi field có giá trị |
| Sửa (kể cả dán nhiều ô, fill-down, bulk PATCH, upsert) | 1 / record, chung `batch_id` | chỉ field thay đổi |
| Xoá mềm | 1 / record | `null` / `null` (dữ liệu vẫn còn trong bảng) |
| Khôi phục | 1 / record | — |
| Xoá cứng: xoá vĩnh viễn từ thùng rác, hoặc job purge sau 30 ngày (T408) | 1 dòng tóm tắt `record.purged` / table: mỗi request xoá vĩnh viễn (≤ 1.000 id, `batch_id` = request) hoặc mỗi lô ≤ 500 record của job (`batch_id` = job) — *sửa ở T422 cho khớp code và CONTRACTS §8* | `after = { count, record_ids }` |
| Import | 1 / record, `batch_id = job_…`, `via.import_job_id` | như Tạo |
| Link (junction) | 1 / record ở **mỗi phía** bị ảnh hưởng, chung `batch_id` | mảng record id trước/sau |
| Attachment | như Sửa | mảng `{id, name}` trước/sau |
| Computed field (formula/lookup, `__updated_*`, auto_number) | **Không ghi** | Giá trị này được tính lại từ nguồn đã có audit |

- Giá trị lưu ở **dạng lưu trữ** (option id, user id, record id), giống `meta.events.changes`. API lịch sử sẽ render theo meta hiện tại; option/user đã bị xoá hiển thị "(đã xoá)".
- Không audit thao tác **đọc**, trừ: export, tải file đính kèm qua share link, gọi AI (SPEC §12), mở khoá share link sai mật khẩu.

### 3. Schema: khôi phục được

- **Xoá field**: audit `field.deleted` lưu snapshot định nghĩa field. Trong 30 ngày có `POST /api/v1/fields/:id/restore` (cột `__deleted_*` được rename lại). Hết hạn → `404`.
- **Xoá table** (*thêm ở T461*, Câu hỏi mở S4b #8): table ở thùng rác **30 ngày** như field (`POST /api/v1/tables/:id/restore`, base admin); quá hạn, cron `tables.purge` (hằng ngày 01:15 UTC) xoá cứng; base admin xoá vĩnh viễn thủ công được, xác nhận bằng tên table (`POST /api/v1/tables/:id/purge`). Field link của table khác trỏ vào table bị purge vào thùng rác nhưng **không** khôi phục được (junction đã drop) → `422 LINK_TABLE_PURGED`. Một dòng audit `table.purged`, `after = { name, record_count, partner_field_ids }` (CONTRACTS §8, §13).
- **Đổi kiểu field**: trong 7 ngày có `POST /api/v1/fields/:id/revert-conversion` (khôi phục cột `__old_*`, định nghĩa cũ). *Sửa bởi T403 (quyết định thiết kế S4 #7)*: mặc định các ô đã sửa sau khi đổi kiểu được **giữ** (chuyển ngược về kiểu cũ), chỉ ô chưa sửa lấy lại giá trị cũ; ghi đè ô đã sửa chỉ khi người gọi chọn `overwrite_later_edits` sau preview báo số ô; hoặc khôi phục bản cũ thành field mới. Preview của revert trả số ô chưa sửa / đã sửa / đã sửa nhưng không chuyển ngược được.
- **Lịch sử record qua đổi kiểu** (T403, Câu hỏi mở S4 #7): backfill không ghi audit/event theo record (như computed field); một dòng `field.converted` có số đếm và định nghĩa trước/sau. Entry lịch sử ghi trước lần đổi kiểu (trước `finished_at`) được render theo định nghĩa cũ (`meta.field_conversions.from_definition`).
- Khôi phục field chỉ là rename, không tiêu slot. Hoàn tác đổi kiểu drop cột mới nên để lại 1 slot đã drop (ADR-20). Cả hai được audit. Hoàn tác đổi kiểu làm ở S4 cùng tính năng đổi kiểu.

### 4. Quyền khi xem

- Lịch sử record: cần quyền **đọc record đó ở thời điểm hiện tại** (table perm + record rule). Không có → `404`.
- Mỗi entry chỉ giữ các field người xem **hiện đang** có quyền đọc (field_rule hiện tại). Entry mà mọi field đều bị ẩn thì bị loại hẳn, không hiển thị "có thay đổi ẩn".
- Thùng rác của table (xem và khôi phục): cần `perm` ≥ `edit`, operation `delete` và record khớp `edit_filter`.
- Revert (§6): entry phải thuộc đúng record đang gọi (khác → `404`), chỉ áp các field người gọi hiện đọc được (CONTRACTS §11.2).
- *Thêm bởi T465 (Câu hỏi mở S4b #3)*: giá trị link/`parent` (id record) render theo quyền **hiện tại** của người xem trên table đích (P20: `title = null`), record đích đã xoá → `deleted: true` (chỉ khi người xem được biết, CONTRACTS §11.1); không có giá trị "theo thời điểm" (title cũ, lookup cũ). Revert mục link đi qua luồng ghi thường, record đích đã xoá bị bỏ và đếm `skipped` (CONTRACTS §11.2).
- Audit log toàn org: chỉ org `owner`/`admin`. Audit theo base: base owner/`admin`. Xem audit log cũng được audit (`audit.viewed`; *sửa ở T709*: tối đa một dòng mỗi người xem, phạm vi và bộ lọc chuẩn hoá mỗi 10 phút — CONTRACTS §11.4).

### 5. Thời hạn lưu, chống sửa, dữ liệu cá nhân

- `AUDIT_RETENTION_DAYS` (mặc định 365; `0` = giữ vĩnh viễn). Cron `partitions.maintain` chạy hằng ngày (idempotent) `DROP` partition quá hạn và tạo trước partition cho 2 tháng tới. Partition `events` giữ 90 ngày (hằng số), không xoá partition còn event chưa dispatch.
- **Append-only**: trigger chặn `DELETE` và `TRUNCATE` trong mọi trường hợp (kể cả trên từng partition), chặn `UPDATE` trừ khi GUC `app.audit_redact = 'on'` do hàm redact bên dưới tự bật rồi khôi phục ngay trong thân hàm. Redact theo user: xoá `ip`/`user_agent` trên các hành động của user đó và thay `before`/`after` của entry có `entity_type = 'user'` là user đó. `DROP` partition (retention) không đi qua row trigger. Hạn chế đã biết: role DB của app cũng đặt được GUC này, nên trigger chỉ chặn lỗi lập trình, không chặn người có quyền DB. Phase 2: tách role DB (app không có `UPDATE`/`DELETE` trên `audit_logs`, hàm redact `SECURITY DEFINER` do role migration sở hữu) và hash chain.
- **Xoá dữ liệu cá nhân**: org **owner** (không phải admin) gọi `POST /api/v1/orgs/:id/audit-logs/redact` với `{ entity_type: "record", entity_ids }` hoặc `{ user_id }`. Hàm `meta.audit_redact(...)` thay `before`/`after` bằng `{"redacted": true}` (với user: thay `ip`/`user_agent` bằng `null`, giữ `actor_id`). Bản thân lệnh redact được audit (không kèm giá trị). Không redact được entry mà chính người gọi là actor, hay entry `audit.*`.
- Xoá user khỏi hệ thống: `meta.users` ẩn danh hoá (`display_name = "Deleted user"`, email băm), audit giữ `actor_id`.

### 6. Khôi phục giá trị cũ

`POST /api/v1/tables/:id/records/:recordId/revert` với `{ "audit_id": "aud_…" }` → tạo một mutation **mới** đặt các field về giá trị `before` của entry đó. Mutation đi qua `RecordMutationService` bình thường (kiểm quyền, record rule, `version`), audit `record.updated` với `via.reverted_from = aud_…`. Không có "sửa lịch sử".

### 7. API (định dạng ở CONTRACTS §11)

```text
GET  /api/v1/tables/:id/records/:recordId/history?field=&cursor=&limit=
POST /api/v1/tables/:id/records/:recordId/revert
GET  /api/v1/tables/:id/records/trash?cursor=&limit=
GET  /api/v1/bases/:id/audit-logs?actor_id=&table_id=&action=&batch_id=&from=&to=&cursor=
GET  /api/v1/orgs/:id/audit-logs?…                 (như trên + base_id)
POST /api/v1/orgs/:id/audit-logs/export           (job 202, ghi audit)
POST /api/v1/orgs/:id/audit-logs/redact
POST /api/v1/fields/:id/restore | /revert-conversion
```

Audit dùng phân trang **cursor** (keyset trên `(created_at, id)`), không dùng offset, vì bảng lớn và chỉ đọc theo thời gian.

## Phương án đã cân nhắc

| Phương án | Kết luận |
|---|---|
| Trigger PostgreSQL trên từng bảng `data.*` ghi audit | Loại: không biết actor/`via`/`batch_id` nếu không truyền GUC; thêm trigger vào DDL động; vi phạm "mọi ghi qua service" |
| Suy ra lịch sử từ `meta.events` | Loại: event phục vụ automation, có thể bị dọn sớm hơn; audit có yêu cầu retention/quyền/redact riêng |
| Import chỉ ghi 1 dòng tóm tắt | Loại: record import sẽ không có dòng "được tạo bởi…" trong lịch sử. 50.000 dòng audit nhỏ vẫn chấp nhận được |
| Ghi audit cho computed field | Loại: nhân khối lượng log, không có thông tin mới |

## Hệ quả

- `RecordMutationService` nhận `AuditContext { actor, via, batch_id, request_id, ip, user_agent }` từ controller/worker; không có context → lỗi lập trình (fail test).
- Khối lượng: bench T108 đo thêm thời gian bulk 1.000 record có audit (mục tiêu overhead < 20%).
- UI: tab "Lịch sử" trong chi tiết record, popover lịch sử từng ô, thùng rác có cột "Người xoá", màn audit log cho admin (FRONTEND.md).
