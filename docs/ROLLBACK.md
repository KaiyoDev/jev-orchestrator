# JEV-ORCHESTRATOR — Rollback Snapshot & Revert Procedure

> Tạo: 2026-09-28, TRƯỚC khi thay đổi bất kỳ file nào.
> Nguyên tắc: extension mới là **purely additive** (chỉ thêm file). Không file hiện có bị sửa/xóa.

## 1. Trạng thái trước thay đổi (pre-state)

| Hạng mục | Giá trị |
|---|---|
| Pi version | `@earendil-works/pi-coding-agent` **0.87.1** (D:/npm-global) |
| Agent dir | `C:/Users/Admin/.pi/agent` |
| `packages` trong settings.json (19) | pi-mcp-adapter, pi-goal-x, pi-extmgr, @narumitw/pi-usage, pi-btw, pi-context-view, pi-custom-system-prompt, pi-tool-repair, @plannotator/pi-extension, pi-herdsman, @pify/pretty, pi-warden, pi-subagents, pi-memory, pi-atelier, pi-cache-graph, pi-cache-optimizer, pi-fabric, @tintinweb/pi-tasks |
| Local extensions (12) | ask-user-question.ts, bash-guard, browser, cbmem.ts, custom-header.ts, herdr-agent-state.ts, interactive-subagents, observational-memory, prompt-snippets, smart-read.ts, web-fetch, web-search |
| `pi-typesafe` (Jev client lib) | `npm/node_modules/pi-typesafe` (dependency ^0.7.0 của pi-warden) |
| TypeSafe key | CÓ trong `pi-typesafe/auth.json` (hash ghi bên dưới; không sao chép giá trị) — auth-state verified |
| mcp.json | **KHÔNG TỒN TẠI** tại thời điểm snapshot (pi-mcp-adapter idle) |

### SHA-256 (16 hex đầu) các file cấu hình
| File | Hash trước |
|---|---|
| `agentDir/settings.json` | f3aeacc9692f24f9 |
| `agentDir/trust.json` | 7485d6a55af70f19 |
| `agentDir/auth.json` | 44136fa355b3678a |
| `agentDir/models.json` | 7e27c2984689f31b |
| `agentDir/pi-typesafe/auth.json` | f310684ffcc0cc22 |
| `agentDir/pi-typesafe/auth-state.json` | c6474b61ddfb7543 |
| snapshot json | `C:/Users/Admin/AppData/Local/Temp/jev-orch-snapshot.json` |

## 2. Những gì SẼ ĐƯỢC thêm (chỉ 2 mục, additive)

1. Thư mục mới: `C:/Users/Admin/.pi/agent/extensions/jev-orchestrator/`
   (index.ts, config.ts, state.ts, jev.ts, router.ts, checker.ts)
2. File config tùy chọn: `C:/Users/Admin/.pi/agent/jev-orchestrator.json` (chỉ khi bật)

**KHÔNG sửa:** settings.json, mcp.json, trust.json, auth.json, models.json, pi-typesafe/*, mọi extension hiện có, Pi core (npm-global), pi-warden, pi-subagents, pi-herdsman, pi-fabric, pi-tasks.

Mặc định cài xong: `enabled: false` → extension load nhưng **no-op hoàn toàn** (không Jev request, không sửa context/tool result, không continue, không đổi model).

## 3. Kill-switch runtime (không cần reload)

```
/jev-orch off         # tắt mọi hook — CHỈ session hiện tại (in-memory, KHÔNG ghi file)
/jev-orch global off  # ghi enabled:false vào config GLOBAL (áp dụng cho session MỚI / sau /reload)
/jev-orch status      # trạng thái cả 2 layer (session + global) + budget + verdicts
```

Ghi chú (2026-09-29): `on / off / shadow / enforce / debug` là **session-scoped** — mỗi
process Pi một toggle riêng, không ảnh hưởng session khác. Chỉ `global <action>` mới ghi
`~/.pi/agent/jev-orchestrator.json`. Session mới kế thừa giá trị GLOBAL tại thời điểm khởi động.

## 4. Rollback hoàn toàn (về chính xác pre-state)

```powershell
cd C:\Users\Admin\.pi\agent
Remove-Item -Recurse -Force extensions\jev-orchestrator   # xóa extension (chỉ thư mục mới)
if (Test-Path jev-orchestrator.json) { Remove-Item jev-orchestrator.json }  # xóa config (nếu từng tạo)
# trong session pi đang chạy:
/reload    # session_shutdown + reload extensions → Pi về đúng pre-state
```

Kiểm tra sau rollback:
- `Test-Path extensions\jev-orchestrator` → False
- hash `settings.json` vẫn = f3aeacc9692f24f9 (không được đổi trong suốt experiment)
- pi chạy bình thường, không còn footer status "jev-orch"

## 5. Lưu ý khẩn cấp

- Mọi lỗi runtime của extension bị catch bởi harness (extension error → `emitError`, không crash pi; handler `tool_call` throw thì **block tool call đó** → nếu thấy tool bị block lạ: `/jev-orch off` + `/reload`).
- Jev requests bị giới hạn bởi `maxRequests` (pi-typesafe client cap + config orchestrator) — không có chi phí vô hạn.

## 6. Log thay đổi 2026-09-29 (sau snapshot này)

- **FINAL evidence window**: `checker.ts` + `buildFinalEvidence` (task + top-3 reports cap 9000/2000/2000 + tail, tổng 16000) + `sessionEntriesToMessages`; FINAL đọc evidence từ **full session transcript** + khối `subagent check verdicts` (branch verdicts).
- **Jev request budget**: `jev.ts` `JevAsk.maxRequests` + `setMaxRequests(n)`; commands `/jev-orch budget [N]` (session) & `/jev-orch global budget N` (persist).
- **Fix nhỏ**: double prefix `ORCHESTRATOR: ORCHESTRATOR` (ROUTE directive); REMOVE stale `.js` artifacts (09-28) khỏi extension dir — jiti resolve `.js` trước `.ts`.
- **Lưu ý**: `trace()` ghi đè `state.lastNote` (hành vi có sẵn) — không gọi trace nơi cần lastNote là verdict.
- **Residual (judge-layer)**: done_ok ~0.2-0.4 khi synthesis cuối thiếu thật — verdict đúng theo contract; bounded loop + escalate hoạt động như thiết kế.
- Verify: tsc strict CLEAN; 44/44 unit; live wf7..wf8e (ROUTE cat=analysis, CHECK branch PASS p=0.94, correction 2/2 + escalate).

## 7. Fix loop-after-escalate (2026-09-30, incident session 01a0f0d0)

- **Bug**: sau escalate (failLoops ≥ maxFailLoops / hết budget), FINAL vẫn RE-FIRE ở mỗi `agent_before_settle` kế tiếp (không có terminal flag) → ask Jev lại (verdict replay từ cache 60s, byte-identical) → re-escalate vô hạn.
- **Fix**: `state.ts` + `finalClosed?: boolean`; `index.ts`: handler skip khi `state.finalClosed`; escalate branch set `finalClosed = true` (1 lần inject "limit reached").
- **Stop loop phiên đang chạy**: `/jev-orch clear` (reset episode) hoặc `/jev-orch off`. Code mới hiệu lực sau /reload hoặc process mới.
- **Test infra**: `Temp/jev-tests` bị Windows Temp-clean (thiếu units.mts/gate-tests.mts) — thay bằng `regress.mts` (25 asserts: route gate/category/depth + check matrix + final category) + evidence/session-msgs (7+5). tsc paths: pi-typesafe → dist/index.d.ts (package dir `npm/node_modules`).

## 8. Fix retryLeft + parallelMax + cache/evidence (2026-09-30, từ audit của user)

- **retryLeft**: CHECK giờ lookup branch TRƯỚC khi ask → `retryLeftFor(branch, maxRetries)` (checker.ts) thay hằng số `maxRetries-1` (index.ts) — "retry budget left: 1" vĩnh viễn đã hết.
- **parallelMax** (IDEA §): `config.ts` limits + `parallelMax: 4`; `router.ts` RouteDecision.parallelMax + directive "At most 4 parallel branches"; CHECK clamp `depthLeft=0` khi `branches.length ≥ parallelMax` (stop fan-out, decision-layer enforces).
- **Evidence truncation** (bug ẩn, jev.ts): ask Jev bị `state.slice(0, stateChars)` (6000) → khối evidence 13-16KB bị cắt GAN TrƯỚC khi đến judge. Sửa: slice 20000 (có bound nội bộ).
- **Cache**: key = sha1(full state sliced 20000 + JSON(questions)) thay vì prefix 1500 + key-of-keys (nguyên nhân replay verdict byte-identical); cache-hit không còn inflate `budgetUsed` (đếm đúng request thật); prune >64 entries.
- Verify: TSC_CLEAN; 31 regress + 12 cat + 7 evidence + 5 session-msgs = 55/55.
- **Layout (2026-09-30, sau §8):** project chuyển sang cấu trúc pi-package — entry `extensions/index.ts` (khai báo `pi.extensions` trong package.json), module `src/`, test `tests/`, doc `docs/`. Đường dẫn module ở các mục trên (vd `checker.ts:153`) = `src/checker.ts`.
- Không cần đụng Pi core để khôi phục trạng thái (mọi thứ revert qua thư mục + 1 config file).
