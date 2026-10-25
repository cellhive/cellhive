# ADR-0018: Hàng đợi job — không dùng named queue theo org

- Trạng thái: Accepted
- Ngày: 2026-09-23
- Sửa: SPEC §11.7, §5.9; BACKLOG T010, T102

## Bối cảnh

SPEC v1.1 §11.7 đặt `queue_name = org:<orgId>` cho mọi run automation của một org, với ý định "hàng đợi theo tenant". Nhưng trong graphile-worker, job thuộc một **named queue chạy tuần tự (concurrency = 1)**. Order chỉ được bảo đảm trong từng queue. Tài liệu còn khuyến cáo không dùng queue name có cardinality cao.

Hệ quả nếu giữ nguyên: một `http_request` treo 10s, retry 5 lần, hoặc một `delay` cài đặt sai sẽ **chặn mọi automation của org đó**, dù worker còn rảnh. Điều này trái với ý định "giới hạn song song bằng `concurrency`".

## Quyết định

1. Job `automation.run`, `events.dispatch` **không** đặt `queue_name`. Song song toàn worker giới hạn bằng `concurrency` của graphile-worker.
2. **Công bằng giữa tenant**: helper chung `acquireOrgSlot(tx, { orgId, kind, cap, countRunning, job })` (`job` = task + payload hiện tại để thêm lại khi đầy trần; bản thêm lại có `attempts = 0` và `max_attempts` = số lượt còn lại) trong `server-core/jobs` (T010). `countRunning` do từng loại job cung cấp: job nền chung đếm `meta.jobs` `status='running'` theo org và `type`; S5 cắm `automation_runs` với trần `AUTOMATION_MAX_RUNNING_PER_ORG` (mặc định 5). Ví dụ với `automation.run`:
   ```text
   BEGIN
   pg_advisory_xact_lock(hashtext('automation-org:' || org_id))
   running := count(automation_runs WHERE organization_id = org AND status = 'running')
   running >= cap → add_job(same payload, run_at = now() + 5s + jitter), kết thúc job hiện tại (không tính là retry)
   else → UPDATE run SET status = 'running'
   COMMIT
   ```
3. `delay` **không** giữ worker: action `delay` kết thúc job hiện tại và `add_job` bước tiếp theo với `run_at` tương lai. Run ở trạng thái `waiting` không tính vào trần.
4. Named queue chỉ dùng cho việc **phải** tuần tự, với cardinality thấp:
   - `schema:<tableId>`: DDL nền, backfill đổi kiểu, `schema.compact_table` (ADR-20).
5. Debounce `computed.recompute` (SPEC §5.9) dùng `job_key = recompute:<fieldId>` với `job_key_mode = 'preserve_run_at'` (throttle 2s, không bị đói khi ghi liên tục). Không dùng `replace`, vì chế độ này đẩy `run_at` mãi về sau.

## Phương án đã cân nhắc

| Phương án | Kết luận |
|---|---|
| Named queue theo org (v1.1) | Loại: concurrency = 1 mỗi org |
| Named queue theo automation | Giữ thứ tự từng automation nhưng một run chậm vẫn chặn automation đó; để làm tuỳ chọn Phase 2 nếu cần "ordered" |
| Không giới hạn theo org | Một org spam event chiếm hết worker (noisy neighbour) |
| Đếm + advisory lock + lên lịch lại | **Chọn**: đơn giản, không thêm hạ tầng |

## Hệ quả

- Không bảo đảm thứ tự giữa các run của cùng automation. Loop guard (§11.6) và `changed_to` vẫn đúng vì mỗi run đọc `before/after` từ payload event.
- Test T010: org A chiếm trần bằng job chậm → job org B vẫn chạy ngay; run bị lên lịch lại không tăng `attempt`.
- Metric mới: `automation_runs_deferred_total{org}`.
