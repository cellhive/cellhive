# ADR-0026: Ghi hàng loạt và automation: lô (`batch`), circuit breaker theo lô, `skip_bulk`

- Trạng thái: Accepted
- Ngày: 2026-09-24
- Sửa: SPEC §11.1, §11.2, §11.6, §14.4; CONTRACTS §8 (event có `batch`, `via`); bổ sung ADR-0023 (`batch_id` của automation). Nguồn: `docs/reviews/lark-gap-analysis.md` A2. Bổ sung 2026-10-05 (T509): mục 8 — giá trị computed tính lại, SPEC §5.9; CONTRACTS §8 `via.computed_recompute`/`job_id`. Bổ sung 2026-10-05 (T510): mục 8 — tính lại cũng sinh event cho automation `record.matches` có điều kiện nêu field đó.

## Bối cảnh

SPEC §11.6 tự tắt automation khi quá 100 run/phút. Mỗi record được tạo hoặc sửa sinh một event `record.*`, và mỗi event khớp trigger thì tạo một run. Như vậy chỉ cần dán 1.000 dòng, import CSV (T308, tối đa 50.000 dòng) hoặc gọi API bulk là automation hợp lệ bị tắt, dù không có vòng lặp nào. Lark đặt ngưỡng 10.000 trigger/phút mỗi flow và trong tài liệu gợi ý kiểm tra xem "có ai vừa dán hàng loạt" (Lark HC 360048488445, Feishu HC 687446300693).

ADR-0023 đã gom thao tác hàng loạt bằng `batch_id` cho audit (`req_…` cho một request, `job_…` cho một job, T308 ghi `batch_id = job_…` và `via.import_job_id`), nhưng event (C§8) chưa mang thông tin này nên automation không biết một event thuộc lô nào.

## Quyết định

1. **Event mang lô**. Event `record.*` thêm hai trường, ghi cùng transaction với mutation:
   - `batch: { "id": "req_…" | "job_…" | "run_…", "size": <số record thay đổi trong cùng lần gọi RecordMutationService> }`;
   - `via` (cùng dạng với audit, ADR-0023).

   Ghi từ automation dùng `batch_id = run_…` (id của run). Đây là phần bổ sung cho ADR-0023, vốn chỉ có `req_`/`job_`. Import ghi theo lô ≤ 1.000 trong cùng một `job_…`, nên mọi event của một lần import có chung `batch.id`. `size` là kích thước của lô ghi đó, không phải tổng cả job.
2. **Event hàng loạt**. Một event được coi là hàng loạt khi có `via.import_job_id`, **hoặc** là giá trị tính lại của một lần chạy job `computed.recompute` (`via.computed_recompute` có `job_id`, mục 8), **hoặc** `batch.size ≥ 2` và nguồn không phải form (`via.share_link_id` của form luôn tạo từng record). Ví dụ: dán nhiều dòng, fill-down, API bulk/upsert, `update_records` theo filter của automation (mục 6), job xoá option select.
3. **Tuỳ chọn `skip_bulk`** trên trigger `record.created`/`record.updated`/`record.deleted` (nhãn UI: "Bỏ qua thay đổi hàng loạt và import"). **Mặc định `false`**: automation vẫn chạy cho từng record, giữ ngữ nghĩa §11.2 và đúng kỳ vọng của tích hợp API tạo vài record một lúc. Trình dựng hiển thị tuỳ chọn này ngay dưới trigger khi automation có action gửi ra ngoài (`send_email`, `send_telegram`, `http_request`, `run_n8n_workflow`). `skip_bulk = true` thì event hàng loạt bị bỏ qua, không tạo run và không tính vào breaker.
4. **Mỗi record một run, có trần fan-out theo lô**. Trigger vẫn nhận từng record (không có trigger "cả lô"). Mỗi automation tạo tối đa `AUTOMATION_MAX_RUNS_PER_BATCH` run (env, mặc định 1.000, tối đa 50.000) cho mỗi `batch.id`. Cách đếm: bộ đếm trong `meta.automation_batch_counters(organization_id, automation_id, batch_id, runs, skipped, PK(automation_id, batch_id))`, tăng trong transaction của `events.dispatch`, dọn sau 24h.
   - **Vượt trần**: không tạo run cho các record còn lại. Tạo **một** run đại diện với `status = skipped`, `error = { "code": "batch_fanout_exceeded", "batch_id", "limit" }`. Run này được cập nhật `skipped` count khi lô tiếp tục vượt. Người nhận thông báo: `run_as` + base admin (ADR-0025, ADR-0029). Automation **không** bị tắt. Người dùng xử lý tiếp bằng `find_records`/`update_records` theo lịch hoặc tăng trần.
5. **Circuit breaker theo đơn vị kích hoạt**. Đơn vị kích hoạt của một run là `batch.id` nếu event là event hàng loạt (mục 2), còn lại là `causation.root_event_id`. Trigger `schedule` dùng lần bắn lịch, `webhook.received` dùng từng request.
   - Tắt khi một automation có **> 100 đơn vị kích hoạt khác nhau trong 1 phút** (thay cho "> 100 run/phút"), hoặc **50 đơn vị liên tiếp thất bại**. Một đơn vị thất bại khi có ít nhất một run `failed` và không có run `succeeded`.
   - Với automation chỉ nhận thay đổi đơn lẻ, mỗi đơn vị là một run, nên ngưỡng giữ nguyên như cũ. Dán hoặc import 50.000 dòng chỉ tính là một đơn vị.
   - Tắt → `disabled_reason = 'circuit_breaker'`, báo `run_as` + base admin.
6. **Automation ghi hàng loạt**. Action `update_records` theo filter (§11.5) ghi theo lô ≤ 1.000 qua `RecordMutationService` với `batch_id = run_…`. Các automation phía sau thấy đây là event hàng loạt (mục 2) có `causation` nối tiếp. Loop guard §11.6 giữ nguyên.
7. **Hàng đợi**. Không có giới hạn run/phút thứ hai. Fan-out lớn nằm trong hàng đợi graphile-worker và được tiết lưu bởi `AUTOMATION_MAX_RUNNING_PER_ORG` (ADR-0018), nên không chặn org khác.
8. **Giá trị computed tính lại** (T509, quyết định `docs/reviews/S4b-decisions-followup.md` §3.4, thay ghi chú S4b bên dưới). Formula/lookup `stored` đổi giá trị do tính lại sinh `record.updated` (`changes` chỉ gồm field computed đổi, `actor = system`, không audit, không đổi `__version`) **chỉ** khi có automation `record.updated` đang bật theo dõi field đó trong `watch_fields`, hoặc automation `record.matches` đang bật có điều kiện nêu field đó (T510; `events.dispatch` quyết định record có chuyển sang khớp không):
   - tính lại **đồng bộ** trong transaction ghi: field computed của chính record mà lần ghi đổi được gộp vào `changes` của event của lần ghi (một event, một run); record khác: `batch`, `via`, `causation` của lần ghi gốc, thêm `via.computed_recompute = true`, `via.job_id = null` — đơn vị kích hoạt như event gốc;
   - tính lại **qua job**: mọi event của **một lần chạy** `computed.recompute` (mọi lô, field, table của lần chạy; retry giữ nguyên) chung `batch.id = job_…` dẫn xuất từ id job graphile-worker, `via = { computed_recompute: true, job_id }`, luôn là event hàng loạt (mục 2) nên `skip_bulk` bỏ qua được và cả lần chạy là **một** đơn vị (mục 5); `causation` gộp bảo thủ qua cột `meta.computed_recompute_queue.causation` (`depth` lớn nhất, chain hợp, root của dòng đầu; depth không tăng) để loop guard vẫn chặn A → X → F → A;
   - giá trị đầu của record vừa tạo/khôi phục (cờ `created` của dòng hàng đợi) không sinh event;
   - trần fan-out áp ngay khi ghi event: qua job, sau `AUTOMATION_MAX_RUNS_PER_BATCH` + 1 event (automation không điều kiện; có điều kiện: sau khi đã có run đại diện) hook chỉ tăng `skipped` (`automation_batch_counters.events` đếm event đã ghi). Một lần tính lại 200k dòng: ≤ 1.000 run + 1 run `skipped`, ≤ 1.001 event mỗi automation, automation không bị tắt;
   - field `virtual` không chọn được trong `watch_fields`/`changed*` hay điều kiện của `record.matches` (`422 AUTOMATION_INVALID` / `INVALID_FIELD_TYPE`).


## Phương án đã cân nhắc

- **Nâng ngưỡng lên 10.000 run/phút như Lark**: vẫn tắt nhầm khi import 50.000 dòng, và không còn bắt được vòng lặp nhanh.
- **Một run cho cả lô (trigger "batch")**: hiệu quả nhưng đổi mô hình trigger/condition/template vốn theo từng record. Để Phase 2 cùng loop/for-each.
- **Mặc định `skip_bulk = true`**: an toàn cho email hàng loạt, nhưng làm hỏng ngầm tích hợp API tạo nhiều record. Chọn mặc định `false` cộng trần fan-out và gợi ý trong UI.
- **Đếm breaker theo `root_event_id`**: mỗi record của một lần dán có `root_event_id` riêng, nên không giải quyết được vấn đề. Cần `batch.id`.

## Hệ quả

- S5: thêm `batch`, `via` vào event (chỉ thêm trường mới, event cũ không có `batch` coi như đơn lẻ), bảng `meta.automation_batch_counters`, env `AUTOMATION_MAX_RUNS_PER_BATCH`.
- T308 đã ghi `batch_id = job_…` và `via.import_job_id` vào audit. S5 chép cùng giá trị sang event, không cần sửa T308.
- Follow record và thông báo gán người (ADR-0029) dùng cùng định nghĩa "hàng loạt" để gom hoặc bỏ qua thông báo.

## Ghi chú S4b (T458, 2026-09-28): giá trị computed tính lại — đã thay bằng mục 8 (T509)

- Giá trị formula/lookup được tính lại tăng dần (`ComputedRecomputeService`, SPEC §5.9) **không** sinh event `record.*` và không có `batch`: automation không thấy chúng ở S4b.
- Chỗ nối cho S5: hook `afterRecompute(tx, { organizationId, recomputed })` (`packages/server-core/src/computed/recompute/changes.ts`), gọi trong transaction đã ghi giá trị, với từng field và các record có giá trị **thực sự đổi**. Mặc định rỗng. S5 dùng nó cho `watch_fields`: sinh event `record.updated` sau khi tính lại xong, `causation` trỏ về event gốc, cùng `batch.id` của lần ghi gốc (hoặc `job_…` của `computed.recompute`) nên breaker theo lô (mục 5) coi cả lần tính lại là **một** đơn vị kích hoạt. T459 cũng nối vào hook này (realtime sau commit qua `afterCommit`).
