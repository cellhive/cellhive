# ADR-0039: AI — một cửa Chat Completions, thang đầu ra có cấu trúc, đầu ra theo tên, dữ liệu tối thiểu, field AI chạy nền

- Trạng thái: Proposed (viết ở BACKLOG T905; Accepted khi T905 merge)
- Ngày: 2026-10-31
- Thay thế / sửa: SPEC §12 (viết lại), §2 (dòng ADR-39), §22 (dòng S8); cách hiểu ADR-12; CONTRACTS §29 (mới, §29.7 ở T905), §6 (`AI_INVALID_OUTPUT`, `AI_PROVIDER_ERROR`, `AI_TIMEOUT`). Nguồn: BACKLOG "Quyết định S8" #2–#5, #8–#18, #21–#23; `docs/reviews/S8-research.md` §2.2–§2.8, §4.

## Bối cảnh

S8 thêm AI (S§12): AI viết công thức, bản nháp automation từ một câu, hỏi đáp trên table trả số/bảng/biểu đồ, field AI sinh theo dòng, action AI. Ràng buộc có sẵn: AI là tuỳ chọn và phải chạy được hoàn toàn bằng LLM tự host (S§1 #4); AI không bao giờ sinh SQL, mọi kết quả chạy theo quyền người hỏi (ADR-12, quy tắc vàng #4); mọi lời gọi tới URL do người dùng cấu hình đi qua lõi chống SSRF (ADR-35 §3); secret chỉ gửi tới host được phép (ADR-36 §4); không dependency/dịch vụ hạ tầng mới nếu tránh được (quy tắc vàng #7); request tương tác phải xong trước `proxy_read_timeout 120s` của nginx.

Thực tế provider (research §2.2–§2.3): mẫu số chung duy nhất của OpenAI, lớp tương thích của Anthropic, Ollama, vLLM, llama.cpp, LiteLLM, OpenRouter là **Chat Completions không stream**. Đầu ra có cấu trúc không đồng đều: OpenAI thực thi `json_schema` strict; lớp tương thích Anthropic **bỏ qua** `response_format` mà không báo lỗi; Ollama/vLLM/llama.cpp ràng buộc khi sinh (đúng hình, không bảo đảm đúng nghĩa); tên tham số giới hạn token khác nhau (`max_completion_tokens` / `max_tokens`); vLLM từ chối `stream_options` khi không stream, model mới của Anthropic từ chối một số tổ hợp `temperature`/`top_p`. Tập con strict JSON Schema không có `oneOf`, bắt mọi khoá trong `required`, gốc phải là object, ≤ 10 tầng. Model local nhỏ hay sai id và cấu trúc đệ quy.

## Quyết định

### 1. Một cửa Chat Completions, không SDK, không dependency (T905)

`LlmClient` trong `packages/server-core/src/ai` là đường duy nhất tới LLM: `POST {base_url}/chat/completions`, `stream: false`, trên `parseOutboundUrl` → `resolveOutboundTarget` (allowlist org, `HTTP_PRIVATE_ALLOWLIST`) → `guardedRequest` (ghim địa chỉ, không redirect, body ≤ 1 MiB, `timeoutMs = min(request_timeout, thời gian còn lại)`). Body chỉ `{ model, messages, stream, <token_param>, response_format? }` — không `temperature`, `top_p`, `seed`, `n`, `stream_options` (mặc định của provider; tránh `400` trên các lớp tương thích). Không Responses API, không API gốc của từng hãng, không SDK `openai`/`ai`, không tokenizer (research §2.7: thêm hàng chục MB và retry/redirect riêng vượt ngoài lõi SSRF; Chat Completions chỉ cần một POST và một parse). JSON Schema lấy từ `z.toJSONSchema` của zod đã có.

API key là secret kind `ai_api_key` (`meta.secrets`, T906) có `allowed_hosts` tự đặt theo host của base URL; client hỏi danh sách host **trước**, chỉ giải mã khi URL khớp (dùng lại `secretHostDecision` của T701) — đổi base URL không mang key sang host khác.

### 2. Thang đầu ra có cấu trúc; zod + engine là trọng tài (T905)

Bậc `json_schema` (strict) → `json_object` (schema trong system prompt) → `prompt` (không `response_format`, schema trong system prompt). Provider trả `400` cho `response_format` → xuống một bậc ngay trong request; bậc dùng được trả về để cài đặt lưu ("Kiểm tra kết nối" dò trước — T906). Ở **mọi** bậc, câu trả lời được đọc như nhau: object JSON đầu tiên → zod → `validate` của tính năng (engine sẵn có: `prepareComputedDefinition`, `validateAutomationDefinition`, `WIDGET_CONFIG_SCHEMAS` + `validateFilter`…) → sai thì gửi lại `{ path, code, message }` (≤ 10 mục, chỉ nói về thứ có trong digest), tối đa **2 vòng sửa** (S§12.2 #1 áp cho mọi tính năng) → `422 AI_INVALID_OUTPUT`. Không dùng tool calling: mọi tính năng là "một câu hỏi → một object", `tool_choice` không đồng đều giữa provider.

### 3. Đầu ra theo tên, phẳng, có enum; server dựng JSON đầy đủ (T905, T907–T911)

Cách hiểu ADR-12 ("AI chỉ sinh Filter DSL / Query DSL / Automation JSON rồi validate bằng zod"): mỗi tính năng có schema zod **riêng cho LLM** dùng **tên** table/field/option lấy từ digest người gọi đọc được (đưa vào JSON Schema dạng `enum`), filter dạng tuple một tầng (C§3); model không bao giờ thấy hay sinh id, SQL hay DSL đệ quy. Server đổi tên → id, dựng DSL/config/definition đầy đủ rồi kiểm bằng zod contract + engine như khi người dùng tự lưu. `automationDefinitionSchema` đầy đủ và Filter DSL đệ quy không bao giờ đưa cho model. Hậu xử lý JSON Schema (C§29.7): inline `$defs`, `oneOf` → `anyOf`, khoá tuỳ chọn → bắt buộc + `null` (đọc về bỏ `null` đó trước zod), `additionalProperties: false`, tuple → mảng cố định độ dài, bỏ từ khoá ngoài tập con (zod vẫn kiểm), gốc không phải object bọc `{ result }`, ≤ 10 tầng; schema đệ quy hoặc map là lỗi lập trình.

### 4. Không streaming ở S8; ngân sách 90 s (T905, T909)

Request tương tác đồng bộ, một hạn 90 s chia cho mọi lời gọi và vòng sửa (dưới 120 s của nginx); hết → `504 AI_TIMEOUT`. `guardedRequest` đọc hết body; JSON có cấu trúc chỉ dùng được khi đủ; narrative ngắn (≤ 400 token). Stream narrative là P1 (cần biến thể `guardedRequest` có timeout nhàn rỗi + parser SSE).

### 5. Dữ liệu tối thiểu, `allow_record_data`, khối dữ liệu không tin cậy (T905–T911)

`allow_record_data = false` (mặc định): chỉ schema người gọi đọc được, **không** nhãn nhóm của aggregate (tên người, tiêu đề record là dữ liệu record) → Q&A không narrative, chỉ "cách hiểu" dựng tất định từ plan (Quyết định S8 #8, gỡ mâu thuẫn S§12.1 / S§12.2 #3). Mẫu chống prompt injection (research §2.6): field AI = map-reduce (mỗi dòng một lời gọi cô lập, không công cụ, đầu ra ràng buộc, chỉ ghi đúng field); Q&A = context-minimization (model chỉ sinh plan, server chạy theo quyền người hỏi); bản nháp automation = plan-then-execute có người duyệt (không lưu, không bật, không `http_request`/`run_n8n_workflow`/`update_records`/`delete_record`/`find_records`/`if`). Dữ liệu do người dùng viết vào prompt luôn ở trong `untrustedBlock`: phân cách có id ngẫu nhiên mới mỗi khối + datamarking (mọi khoảng trắng → `ˆ`), nội dung không thể đóng khối; system prompt nói rõ đó là dữ liệu.

### 6. Quota kiểm-rồi-ghi, audit theo thao tác (T906, T910, T911)

Quota token/ngày/org (`meta.ai_usage_daily`, ngày theo múi giờ org): kiểm trước mỗi lời gọi, ghi sau theo `usage` của provider — kể cả câu trả lời bị từ chối/cắt (client báo usage của mọi câu trả lời đọc được); thiếu `usage` → `ceil(ký tự / 3)`, cờ `estimated`. Vượt tối đa = lời gọi đang chạy × `max_tokens` — chấp nhận thay vì đặt chỗ trước (không phải dọn chỗ đặt khi worker chết); đổi sang đặt chỗ nếu đo thấy vượt > 1 % trần. Audit `ai.requested` một lần mỗi request tương tác, mỗi lô sinh nền, mỗi bước action.

### 7. Field AI = `options.ai` + hàng đợi riêng + runner riêng (T910)

Field AI là field `text` hoặc `select` một lựa chọn có `options.ai` (grid, filter, form, export, đổi kiểu, lịch sử dùng lại nguyên). Thay đổi nguồn xếp `(field, record)` vào `meta.ai_generation_queue` trong **cùng transaction** qua "một cửa" thay đổi computed (gộp trùng); runner graphile-worker thứ hai chỉ nhận task `ai.*` (`AI_CONCURRENCY`, mặc định 2) để lời gọi 5–60 s không chiếm slot `events.dispatch`/`automation.run`; ghi qua `RecordMutationService` chỉ khi nguồn chưa đổi từ lúc đọc; hết quota/tắt dữ liệu → `paused`, cron trả về `queued`. Ô chỉ đọc; giá trị luôn "nghiêm" (Quyết định S8 #9).

### 8. Provider giả cho CI, không "mock" trong code sản phẩm (T905)

`startFakeOpenAiServer` (`@cellhive/server-core/testing`, `node:http`, không dependency, không nạp ở runtime) trên cổng loopback: test int và E2E đi đúng đường thật (SSRF, mục allowlist `localhost:<port>`, parse, quota, audit). Chế độ kịch bản (hàng đợi, `POST /__script`, dấu hiệu trong tin nhắn cuối) và tất định (instance tối thiểu của schema, `enum` → phần tử đầu; text = tiền tố + băm), bật/tắt khả năng (`json_schema`, `json_object`, `usage`, lỗi, chậm), ghi lại mọi request. Eval với model thật chạy tay (T917), không trong CI.

## Phương án đã cân nhắc

| Quyết định | Phương án | Chọn | Lý do |
|---|---|---|---|
| Client LLM | SDK `openai` / Vercel `ai` / client tự viết | Tự viết trên `guardedRequest` | Một cửa SSRF bắt buộc; một endpoint; SDK thêm dependency, retry, redirect riêng |
| Giao thức | Chat Completions / Responses API / API gốc từng hãng | Chat Completions | Mẫu số chung của mọi provider local và gateway |
| Đầu ra có cấu trúc | luôn `json_schema` / tool calling / thang | Thang + zod + engine + sửa | Provider không đồng đều; zod là trọng tài cuối cùng |
| Hình thức đầu ra | id + DSL đầy đủ / tên + phẳng | Tên + phẳng + enum | Model nhỏ sai id/đệ quy; strict mode không `oneOf`, ≤ 10 tầng |
| Streaming | SSE tới trình duyệt / không | Không ở S8 | `guardedRequest` đọc hết body; JSON chỉ dùng được khi đủ |
| Request tương tác | đồng bộ / job + polling | Đồng bộ, 90 s | Đơn giản; dưới 120 s của proxy |
| Narrative khi `allow_record_data = false` | gửi aggregate / không | Không | Nhãn nhóm là dữ liệu record |
| Field AI | kiểu field mới / `options.ai` trên text/select | `options.ai` | Mọi đường hiện có dùng lại nguyên |
| Hàng đợi field AI | `computed_recompute_queue` / bảng riêng | Bảng riêng, cùng cửa thay đổi | Gọi mạng chậm, có quota/pause/lỗi từng ô |
| Worker | runner chung / runner AI riêng | Runner riêng | Không chiếm slot của event/automation |
| Quota | đặt chỗ rồi quyết toán / kiểm rồi ghi | Kiểm rồi ghi | Vượt tối đa nhỏ, không phải dọn chỗ đặt |
| Provider giả | `msw` / aimock, mockllm / model nhỏ / tự viết | Tự viết `node:http` | `msw` bỏ qua kiểm DNS/địa chỉ; công cụ ngoài thêm dependency/dịch vụ |

## Hệ quả

- Không dependency mới, không dịch vụ mới; một env mới `AI_CONCURRENCY` (T910); migration `0055_ai_settings`, `0056` hàng đợi (T906, T910).
- Lớp tương thích Anthropic chỉ có bậc `prompt` (nó bỏ qua `response_format`); muốn đầu ra có cấu trúc thật thì đi qua gateway (LiteLLM, OpenRouter). Thang đọc JSON giống nhau ở mọi bậc nên provider "im lặng bỏ qua" vẫn dùng được.
- Ràng buộc bị bỏ khỏi JSON Schema (độ dài chuỗi, pattern) chỉ được zod kiểm sau khi sinh → có thể tốn một vòng sửa; đổi lấy việc không mất bậc vì provider từ chối từ khoá lạ.
- Chất lượng phụ thuộc model: model local nhỏ có thể không đạt bản nháp automation dù có enum + 2 vòng sửa — đo bằng bộ eval tay (T908, T917), thu hẹp tập trigger/action hoặc ghi model tối thiểu thay vì nới nghiệm thu.
- Instance có `HTTP_PRIVATE_ALLOWLIST=off` không gọi được LLM trong mạng nội bộ; provider cấp instance qua env là P1 (Câu hỏi mở S8 #2).
- P1 đã biết: streaming narrative, chat nhiều lượt, chọn model theo tính năng, sửa tay ô field AI, quota theo người, cờ AI theo workspace.
