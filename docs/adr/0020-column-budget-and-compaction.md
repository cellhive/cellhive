# ADR-0020: Ngân sách cột vật lý và compaction bảng dữ liệu

- Trạng thái: Accepted
- Ngày: 2026-09-23
- Sửa: SPEC §5.4, §5.5, §5.10; CONTRACTS §6; BACKLOG T102

## Bối cảnh

ADR-05 chọn "mỗi field = một cột thật". PostgreSQL có giới hạn cứng **1.600 cột/bảng** (`MaxHeapAttributeNumber`, hằng số biên dịch). Cột bị `DROP COLUMN` chỉ được đánh dấu `attisdropped` trong `pg_attribute`, **vẫn chiếm slot vĩnh viễn**. `VACUUM FULL` và `CLUSTER` ghi lại dữ liệu nhưng không đánh số lại `attnum`, nên không lấy lại được slot. Cách duy nhất là tạo bảng mới.

Thiết kế v1.1 tiêu slot ở mọi thao tác:
- Đổi kiểu field: `RENAME` cột cũ thành `__old_` rồi `ADD` cột mới → +1 slot.
- Xoá field: rename thành `__deleted_`, purge bằng `DROP` → slot không được trả lại.

Một table bị sửa schema thường xuyên có thể gặp lỗi `tables can have at most 1600 columns` dù chỉ hiển thị vài chục field.

**Có bỏ giới hạn được không?** Không, trên bản PostgreSQL chính thức. Muốn nâng thì phải sửa hằng số và tự biên dịch PostgreSQL. Cách đó phá cam kết "dùng image chính thức, nâng cấp an toàn", và còn vướng giới hạn kích thước tuple (trang 8 KB; mỗi giá trị TOAST tốn ~18 byte con trỏ). Vì vậy giải pháp là **quản lý ngân sách** chứ không nâng trần.

## Quyết định

1. **Giới hạn field đang hoạt động**: `MAX_FIELDS_PER_TABLE` mặc định 500 (Airtable cũng dùng 500), trần cứng 1.000. Vượt → `422 FIELD_LIMIT_EXCEEDED`.
2. **Đo slot thật**: `SchemaService` tính `used_slots = count(*) FROM pg_attribute WHERE attrelid = $tbl::regclass AND attnum > 0`, **gồm** cột đã drop, trước mọi DDL tiêu slot.
   - `used_slots >= 1400` → enqueue `schema.compact_table` (queue `schema:<tableId>`, ADR-18), thông báo admin base.
   - `used_slots >= 1550` → từ chối DDL tiêu slot với `409 SCHEMA_LOCKED` cho tới khi compaction xong.
3. **Compaction** (`schema.compact_table`), một transaction, `statement_timeout` riêng cho job (mặc định 30 phút):
   1. Advisory lock theo table; đánh dấu table đang compact → mọi ghi record/DDL trả `409 SCHEMA_LOCKED` (client retry).
   2. `LOCK TABLE old IN SHARE MODE` (chặn ghi, **vẫn cho đọc**).
   3. `CREATE TABLE data.t_<newShortId>` với cột hệ thống + mọi cột đang dùng theo meta (giữ nguyên tên `f_<fieldShortId>`, kiểu, collation, `NOT NULL`, `CHECK`), bỏ cột `__deleted_*` đã quá hạn khôi phục 30 ngày (đặt `meta.fields.purged_at`); cột `__deleted_*` còn trong hạn và cột `__old_*` còn trong hạn 7 ngày được giữ lại. Nếu vì vậy table vẫn ≥ 1400 slot, worker ghi cảnh báo và DDL tiêu slot tiếp tục bị chặn ở 1550 cho tới khi các cột đó hết hạn.
   4. `INSERT INTO new (...) OVERRIDING SYSTEM VALUE SELECT ... FROM old` (giữ `__auto`), sau đó `ALTER TABLE new ALTER COLUMN __auto RESTART WITH max(__auto)+1`.
   5. Dựng lại index (trigram primary, GIN select, unique partial, `__created_at`, `__deleted_at`, `__parent_id`) và FK tự tham chiếu `__parent_id`.
   6. Với mọi junction `data.l_*` trỏ tới bảng cũ: drop FK, thêm FK trỏ bảng mới `NOT VALID`, rồi `VALIDATE CONSTRAINT`.
   7. `DROP TABLE old` rồi `ALTER TABLE data.t_<newShortId> RENAME TO <tên cũ>` (lock tối đa `lock_timeout`, thất bại → retry cả job), đổi tên index/constraint tương ứng; `UPDATE meta.tables SET compacted_at = now()`. **Tên bảng vật lý giữ nguyên** nên BI tool đọc trực tiếp không bị hỏng (SPEC §1); vô hiệu cache meta của table trên mọi instance api (qua pub/sub) và phát `schema.changed`. **Không** tăng `permission_version` (quyền không đổi; tăng sẽ buộc mọi client tải lại toàn bộ dữ liệu).
4. Vì tên bảng và tên cột giữ nguyên nên formula, filter, lookup, view và BI tool **không cần sửa**.
5. Tối ưu cho sau (không làm trong MVP): với bảng nhỏ có thể đổi kiểu tại chỗ bằng `ALTER COLUMN ... TYPE ... USING` (không tiêu slot nhưng giữ ACCESS EXCLUSIVE suốt quá trình rewrite).

## Phương án đã cân nhắc

| Phương án | Kết luận |
|---|---|
| Tự biên dịch PG với `MaxHeapAttributeNumber` lớn hơn | Loại: không dùng được image chính thức/Postgres được quản lý, vẫn vướng giới hạn kích thước tuple |
| Cột "overflow" `jsonb` cho field vượt ngưỡng | Loại: đi ngược ADR-05 (hai đường query, planner kém) |
| `VACUUM FULL` / `pg_repack` định kỳ | Loại: không lấy lại slot `attnum` |
| Ngân sách + compaction bằng bảng mới | **Chọn** |

## Hệ quả

- Compaction chặn ghi trong vài giây đến vài chục giây với bảng 200k dòng (đo trong T102, ghi vào báo cáo). Với ngân sách 1.400/1.600 và giới hạn 500 field, compaction hiếm khi xảy ra.
- Metric `schema_table_slots_used{table}`; cảnh báo khi > 1.200.
- Bảng rất rộng với nhiều giá trị lớn vẫn có thể gặp `row is too big`. Lỗi này được map thành `422 INVALID_CELL_VALUE` kèm thông báo rõ.
