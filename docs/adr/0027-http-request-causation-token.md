# ADR-0027: Chống vòng lặp khi `http_request` gọi lại webhook của chính instance

- Trạng thái: Accepted
- Ngày: 2026-09-24
- Sửa: SPEC §11.6, §13.2, §13.3; CONTRACTS §10. Nguồn: `docs/reviews/lark-gap-analysis.md` A5.
- Sửa đổi (2026-10-18, T616, coordinator chốt mục T610 ở BACKLOG "Tồn đọng S5c", mức high): `target` của token gắn **chính instance** — SHA-256(host của `PUBLIC_URL` + tiền tố path hook `/api/v1/hooks`) — thay cho "`host + path` đích" ở §1. Phía nhận (§2) kiểm host (host của `PUBLIC_URL` hoặc `Host` sau `TRUSTED_PROXIES`, như cũ) và path request nằm dưới tiền tố `/api/v1/hooks` (đúng ranh giới đoạn), không còn so path hook chính xác. Lý do: token gắn URL đích (n8n) nên `/hooks/:token` luôn từ chối `target_mismatch` khi n8n/hệ ngoài chuyển tiếp header, chuỗi về depth 0 và vòng A → n8n → hook B → A chỉ bị chặn bởi rate limit hook — §5 ("chuyển tiếp header") không có tác dụng. Giữ AES-256-GCM, khoá HKDF `automation-causation-v1`, `exp` 1 h, mỗi lần thử một token mới; token giả/hỏng/hết hạn/của instance khác vẫn → depth 0. Token copy sang hook khác cùng instance (hoặc bên nhận ngoài dùng lại) nay được nhận — chỉ làm chuỗi sâu thêm, không reset được (an toàn hơn). Hệ quả: test "copy sang path khác → depth 0" ở mục Hệ quả đổi thành "gắn đích khác/instance khác → depth 0". Định dạng: CONTRACTS §10, SPEC §11.6, §13.3.
- Sửa đổi (2026-10-25, sửa lỗi review automation — chốt nghĩa "một bước nhảy = +1"): §1/§2 — `depth` trong token là **depth của run gửi** (= depth event trigger của nó; run `schedule`/không còn event: depth của run), `automation_chain` gồm cả automation gửi; phía nhận giữ `depth + 1`. Trước đây token mang causation của các lần ghi của run (đã `+1`) rồi hook cộng thêm 1, nên A → hook → B tốn 2 mức trong khi A → record → B tốn 1 (với `automation_max_depth = 2`, B bị chặn qua hook nhưng chạy qua record). Nay hai đường như nhau: người (0) → A → hook (1) → B → record (2). Code: `outboundHttpCausation` (`events/event.ts`) khi đỗ bước HTTP vào outbox. Token cũ đang bay (≤ 1 h) chỉ làm chuỗi sâu hơn 1 mức — an toàn. SPEC §11.6, CONTRACTS §10.

## Bối cảnh

Loop guard §11.6 dựa vào `causation` (`root_event_id`, `depth`, `automation_chain`) truyền qua event nội bộ. Nhưng một automation có thể dùng `http_request` gọi `POST /api/v1/hooks/:token` của **chính instance** (trực tiếp, hoặc qua n8n). Request vào webhook tạo event `webhook.received` mới với `depth = 0`. Nếu automation B (trigger webhook) lại sửa record làm A chạy, vòng A → HTTP → B → A lặp vô hạn, loop guard không nhìn thấy.

Lark chặn node HTTP gọi đúng URL webhook của chính flow (lỗi `800005646`, Feishu HC 383585269199).

Hai cách được đề xuất trong gap analysis:

- **(a) Chặn URL của chính instance**: từ chối `http_request` tới host của `PUBLIC_URL` và path `/api/v1/hooks/`.
- **(b) Truyền causation qua header có ký/mã hoá**: request ra mang causation, webhook vào tiếp nhận và nối tiếp chuỗi.

## Quyết định

Chọn **(b)**, token causation mã hoá.

1. Mọi request ra của `http_request` và `run_n8n_workflow` gửi header `X-Cellhive-Causation: v1.<token>` (tên header theo tên dự án — chốt `X-Cellhive-Causation` ở ADR-37; tiền tố API token `cht_` cũng chốt ở ADR-37).
   - `token` = base64url(AES-256-GCM(key, payload)).
   - `key` = HKDF-SHA256(`APP_MASTER_KEY`, info `"automation-causation-v1"`).
   - `payload = { root_event_id, depth, automation_chain, target, exp }`. `target` = SHA-256 của `host + path` đích (không gồm query). `exp` = thời điểm gửi + 1 giờ, đủ cho mọi lần retry (§11.7). Mỗi lần retry sinh token mới.
2. `POST /api/v1/hooks/:token` đọc header nếu có. Token giải mã được, chưa hết hạn, và `target` khớp host + path của chính request (host lấy theo `PUBLIC_URL` hoặc `Host` sau proxy tin cậy) → event `webhook.received` nhận `causation = { root_event_id, depth: depth + 1, automation_chain }` thay vì depth 0. Loop guard §11.6 áp như với event nội bộ: `depth ≥` giới hạn hoặc automation đã có trong chain thì không kích hoạt.
3. Token sai, hết hạn hoặc sai `target` → **bỏ qua header** (coi như request ngoài, `depth = 0`), không từ chối request, ghi metric `automation_causation_rejected_total`. Không log token.
4. Token được mã hoá, không chỉ ký, nên bên nhận bên ngoài không đọc được id event hay automation nội bộ. Token gắn với instance (không gắn org), vì automation id là duy nhất toàn instance. Vòng lặp đi qua hai org trên cùng instance vẫn bị chặn.
5. Lưới an toàn cho vòng lặp đi qua trung gian làm rơi header (vd n8n không chuyển tiếp header): rate limit theo từng webhook (§13.2, mặc định 5 req/s) và circuit breaker theo đơn vị kích hoạt (ADR-0026). Tài liệu n8n hướng dẫn chuyển tiếp header `X-Cellhive-Causation` khi workflow n8n gọi ngược lại Cellhive.

> **Sửa đổi (2026-10-18, T616)** — áp cho §1, §2, §5: header chuyển tiếp chỉ có tác dụng khi token gắn **chính instance** (host `PUBLIC_URL` + tiền tố `/api/v1/hooks`, phía nhận kiểm theo tiền tố path hook) thay vì URL đích. Chi tiết ở dòng "Sửa đổi (2026-10-18, T616)" đầu ADR; nội dung đã Accepted ở trên giữ nguyên.

## Phương án đã cân nhắc

- **(a) Chặn theo URL**: dễ cài nhưng không đủ. Instance thường truy cập được qua nhiều tên: `PUBLIC_URL`, tên service Docker `api:3000`, IP LAN, domain phụ, reverse proxy, dịch vụ rút gọn URL có redirect. Chặn theo URL còn cấm luôn trường hợp hợp lệ: một base gọi webhook của base khác cùng instance để chuyển dữ liệu. Với (b), trường hợp đó vẫn chạy, chỉ bị giới hạn độ sâu.
- **Header chỉ ký HMAC, không mã hoá**: lộ `root_event_id`, id automation cho bên thứ ba nhận request.
- **Kết hợp (a) và (b)**: (a) không thêm được gì khi đã có (b), mà vẫn gây ra các trường hợp chặn nhầm ở trên.

## Hệ quả

- S5: sinh token trong `http_request`/`run_n8n_workflow`, đọc token trong handler `/hooks/:token`. Integration test: A (record.updated) → `http_request` tới hook của B → B sửa record kích hoạt A → dừng ở depth giới hạn; token giả hoặc copy sang path khác → depth 0.
- CONTRACTS §10 ghi header này cạnh header Standard Webhooks.
- Đổi `APP_MASTER_KEY` làm token đang bay mất hiệu lực. Hệ quả chỉ là request đó được coi là ngoài (depth 0), chấp nhận được.
