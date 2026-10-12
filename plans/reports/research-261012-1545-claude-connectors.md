# Research: Claude Connectors (Claude.ai / Claude Workspace)

- **Thời điểm nghiên cứu:** 2026-10-12 15:45 (+07:00)
- **Phạm vi:** Tính năng Connectors trên Claude.ai / Claude Desktop / Cowork (không đi sâu Claude Code connectors hay MCP connector của Messages API, chỉ chạm đủ để thấy bức tranh chung)
- **Nguồn chính:** support.claude.com (Help Center), claude.com/docs (Claude.ai Documentation), platform.claude.com (Developer Platform docs). Toàn bộ nội dung dưới đây được lấy trực tiếp từ các trang này hôm nay, không dùng nguồn thứ ba.

## Mục lục

1. [Kết luận nhanh](#kết-luận-nhanh)
2. [Connector là gì](#connector-là-gì)
3. [Các loại connector](#các-loại-connector)
4. [Cách kết nối và sử dụng](#cách-kết-nối-và-sử-dụng)
5. [Connector nổi bật](#connector-nổi-bật)
6. [Interactive connectors (MCP Apps)](#interactive-connectors-mcp-apps)
7. [Phân quyền và quản trị cho Team/Enterprise](#phân-quyền-và-quản-trị-cho-teamenterprise)
8. [Kiến trúc và giới hạn kỹ thuật](#kiến-trúc-và-giới-hạn-kỹ-thức)
9. [Bảo mật](#bảo-mật)
10. [Liên hệ với MCP connector của API](#liên-hệ-với-mcp-connector-của-api)
11. [Bước tiếp theo](#bước-tiếp-theo)

## Kết luận nhanh

Connectors là cơ chế chính thức để Claude đọc dữ liệu và thao tác trực tiếp trong các app bên ngoài (Gmail, Drive, Slack, Linear, Microsoft 365…). Nền tảng kỹ thuật là MCP (Model Context Protocol), chạy ở dạng remote server được gọi từ hạ tầng cloud của Anthropic — kể cả khi bạn dùng Claude Desktop hay Cowork. Có 3 nhãn mức độ kiểm duyệt: **Verified** (Anthropic test kỹ), **Community** (chỉ sàng lọc nhẹ), **Custom** (tự thêm theo URL, không kiểm duyệt). Doanh nghiệp có lớp quản trị riêng: bật/tắt theo org, hạn chế action read/write, Enterprise-managed auth qua IdP. Điểm cần nhớ nhất khi tự vận hành: custom connector **phải** reachable từ internet công cộng (từ IP ranges của Anthropic), muốn giữ server trong mạng riêng thì dùng MCP tunnels hoặc allowlist IP.

## Connector là gì

Theo Help Center (`use-connectors-to-extend-claude-s-capabilities`):

- Connector cho phép Claude truy cập app/dịch vụ của bạn, lấy dữ liệu và **thao tác** trong dịch vụ đó (tạo issue Linear, gửi tin nhắn Slack, tìm file Drive).
- Claude **thừa hưởng quyền của từng người dùng** trên dịch vụ được kết nối: nếu người đó không thấy được một file/channel/record trong hệ thống gốc thì connector cũng không với tới. Ngoại lệ: connector custom dùng credential chung thì với tới những gì credential đó với tới.
- Connector dùng được xuyên suốt: Claude web, Claude Desktop, mobile, Cowork, Claude Code và API (qua MCP Connector).

Claude tự đề xuất app phù hợp: sau khi kết nối, Claude có thể tự đưa app vào hội thoại khi hợp lý, không cần gọi tên mỗi lần.

## Các loại connector

Có hai trục phân loại, từ 2 nguồn docs khác nhau và khớp nhau:

### Theo nơi chạy (`when-to-use-desktop-and-web-connectors`)

| Tool của bạn | Dùng | Khả dụng trên |
|---|---|---|
| Cloud/SaaS (Slack, Notion, Linear…) | Remote connector | Mọi surface |
| Có trong Connectors Directory | Remote connector | Mọi surface |
| Chạy trên máy bạn (file local, DB localhost) | Desktop extension | Desktop, Claude Code |
| Bạn tự build, có URL public | Remote connector (custom) | Mọi surface |
| Bạn tự build, chạy local | Desktop extension | Desktop, Claude Code |

Plugin có thể gói cả remote lẫn local MCP; plugin tham chiếu remote MCP dùng được mọi nơi, local MCP chỉ chạy trong Cowork/Claude Code chứ không chạy trong chat web.

### Theo mức kiểm duyệt (`connector verification`)

- **Verified:** Anthropic đã test tools về chất lượng/tương thích, đạt Software Directory Policy tại thời điểm review, hiển thị dấu check. Anthropic nói rõ đây **không phải** security audit; developer vẫn sở hữu và có thể thay đổi tools sau khi được verify.
- **Community:** developer thứ ba build, Anthropic chỉ sàng lọc trước khi listing chứ không review sâu. Cùng khả năng như connector khác khi đã kết nối.
- **Custom:** tự thêm bằng URL, Anthropic không review. Free plan bị giới hạn 1 custom connector.

Quan trọng: directory connector và custom connector **chạy cùng một hạ tầng MCP** (runtime, transport, auth, tool-calling giống hệt nhau) — khác nhau chỉ ở chỗ review, khả năng được tìm thấy trong app, và distribution (`directory-vs-custom.md`). Directory connector thì có listing URL vĩnh viễn dạng `https://claude.ai/directory/connectors/SLUG` và được gợi ý trong sản phẩm (Suggested Connectors); custom connector chỉ có install link prefill hoặc nhập tay.

## Cách kết nối và sử dụng

Flow chuẩn từ `getting-started` (docs claude.com):

1. Mở **Customize > Connectors** (trên web hoặc desktop app), chọn **Discover** để duyệt directory.
2. Chọn connector → **Connect to Claude**; một số connector hỏi thêm server URL hoặc region.
3. Đăng nhập dịch vụ và duyệt quyền (OAuth) — trang sign-in mở trong browser.
4. Xác nhận: connector xuất hiện ở **Your connectors** với trạng thái Connected.
5. Trong hội thoại: nút **+** → **Connectors** → bật toggle cho connector trong chat đó. Mặc định **Auto**; nếu bật từ 10 connector trở lên nên chuyển sang **On demand** để tiết kiệm context.

Trên Team/Enterprise: Owner phải bật connector ở **Organization settings > Connectors** trước ("Browse connectors" → "Add to your team"), sau đó từng thành viên tự authenticate. Nếu connector đã có trong directory nhưng URL là private (ví dụ workspace Workato riêng), nó vẫn hiện branding của service đó thay vì nhãn Custom.

## Connector nổi bật

Từ Help Center và directory index trong docs:

- **Google Workspace** (`use-google-workspace-connectors`): Gmail (tìm kiếm, soạn gửi email — mặc định hỏi duyệt từng action), Google Calendar (xem/tạo sự kiện), Google Drive (tìm kiếm, trích xuất text từ Docs/Sheets/Slides/PDF/Office — không xử lý ảnh nhúng), và riêng **Google Docs/Sheets/Slides** là connector tách biệt cho phép Claude chỉnh sửa tài liệu live trong pane bên cạnh chat (beta, hai bên cùng sửa một lúc).
- **Microsoft 365** (`set-up-the-microsoft-365-connector`): tìm kiếm SharePoint, OneDrive, Outlook, Teams. Yêu cầu Microsoft Entra tenant trên gói Business (account cá nhân @outlook.com/@hotmail.com không kết nối được); cần Global Administrator duyệt consent một lần. Write tools (gửi email, quản lý calendar, tạo file, nhắn Teams) là lớp bật riêng với Microsoft Graph scopes bổ sung; email do Claude gửi có attribution header nhận diện agent-initiated; write không hỗ trợ attachment và có per-user limits.
- **Interactive connectors:** Amplitude, Asana, Box, Canva, Clay, Figma, Hex, Slack (xem mục dưới).
- Directory còn có GitHub, Slack, Linear, Notion và nhiều dịch vụ khác; mỗi listing ghi rõ use case, khả năng read/write, và availability.

## Interactive connectors (MCP Apps)

Từ `use-interactive-connectors-in-claude`:

- Một số connector render **app live ngay trong hội thoại**: dashboard phân tích, task board, design tool — thay vì chỉ trả text. Ví dụ điển hình: hỏi Claude về trạng thái dự án, nó mở luôn bảng Asana trong chat để bạn tick task trong khi vẫn nói chuyện với Claude.
- Hai dạng hiển thị: **inline card** (component gọn trong hội thoại) và **fullscreen view** (giao diện immersive cho visualization/document editing, vẫn giữ ô chat).
- Claude cũng có thể tự sinh visual (diagram, chart) khi không có connector interface nào phù hợp.
- Về mặt kỹ thuật: chạy trong **sandboxed iframe với CSP nghiêm ngặt**, giao tiếp bằng JSON-RPC có audit, server phải khai báo trước external domains. Đây chính là extension **MCP Apps** của MCP (mở, mã nguồn mở).
- Không hỗ trợ mua hàng/giao dịch tài chính qua interactive connectors.
- Owner Team/Enterprise có thể tắt riêng tool calls tạo interactive UI mà không tắt connector.

## Phân quyền và quản trị cho Team/Enterprise

- **Bật theo org:** Owner/Primary Owner bật connector ở Organization settings trước; thành viên vẫn phải tự authenticate. Trên Enterprise, Owner có thể chặn service trên verified domain của mình bị kết nối vào Claude account ngoài tổ chức.
- **Hạn chế action org-wide** (`Tool permissions`): mỗi nhóm quyền (read-only, write/delete) đặt được **Always allow / Needs approval / Blocked**, áp dụng cho toàn org, cá nhân không override được. Restrict trong Claude chỉ thu hẹp, không bao giờ mở rộng quyền so với hệ thống gốc.
- **Enterprise-managed auth** (`authorize-mcp-connectors-for-your-entire-organization`): admin authorize connector **một lần** qua identity provider; team thừa hưởng tự động ở lần đăng nhập đầu, identity kế thừa từ groups/roles của IdP. Chọn role nào được connector (dùng custom role để pilot với một team trước), chọn scopes, thu hồi bằng deprovisioning trong IdP. Có thể bật song song với browser sign-in như fallback khi IdP lỗi.
- **API analytics:** Admin API có endpoint **Get Connector Usage (Beta)** để theo dõi usage connector theo org.

## Kiến trúc và giới hạn kỹ thuật

Điểm kiến trúc quan trọng nhất, được nhấn ở 2 nguồn riêng biệt:

- **Remote connector luôn được gọi từ cloud của Anthropic, không phải từ máy bạn** — kể cả trong Cowork hay Claude Desktop chạy local. Server MCP phải reachable qua internet công cộng từ Anthropic IP ranges. Server sau VPN/firewall/mạng riêng sẽ không kết nối nổi dù máy bạn vào được.
- Ba lối thoát cho mạng riêng:
  1. **Allowlist IP ranges của Anthropic** trên firewall (outbound-only từ góc nhìn của bạn).
  2. **MCP tunnels** (docs mới): deploy một stack tunnel (Helm/Docker Compose) để Claude tới được MCP server trong mạng riêng mà không mở inbound port; có tài liệu setup, OAuth qua tunnel, troubleshooting.
  3. Local MCP server khai trong `claude_desktop_config.json` của Claude Desktop — cơ chế khác, dùng mạng local thật, nhưng chỉ chạy trong Desktop (không có trong claude.ai/Cowork).
- Với **MCP connector của Messages API** (platform docs, beta `mcp-client-2025-11-20`; bản cũ `mcp-client-2025-04-04` đã deprecated): chỉ hỗ trợ **tool calls** trong feature set của MCP spec; không hỗ trợ server STDIO local; chỉ nhận server HTTP (Streamable HTTP hoặc SSE). Cấu hình qua `mcp_servers` + `mcp_toolset` trong `tools`, có allowlist/denylist và per-tool config, OAuth bearer token, nhiều server một request.
- Directory connector có thêm đặc quyền hạ tầng: Anthropic-held client credentials (không có cho custom), và được cho phép allowlist external-link destinations để bỏ modal xác nhận (custom luôn hiện modal).

## Bảo mật

Tổng hợp từ trang custom connectors + verification + interactive:

- Dữ liệu truyền mã hoá; bạn chỉ sync được nội dung bạn có quyền xem ở nguồn. Dịch vụ được kết nối xử lý dữ liệu trên hạ tầng của họ, dưới điều khoản của họ — setting "US-only inference" của Enterprise **không** đổi được nơi third-party service chạy.
- Với Team/Enterprise: quyền thực thi ở mức user; chat có nội dung sync từ connector không share được; connectors chỉ khả dụng trong private projects.
- Rủi ro được Anthropic thừa nhận chính trong docs: **prompt injection** từ malicious MCP servers (hidden instructions), và developer có thể **đổi hành vi tool sau khi bạn đã kết nối**. Claude có lớp bảo vệ tự động nhưng docs khuyến cáo review tool inputs/outputs và chỉ nối server tin tưởng.
- OAuth credentials/API key lưu mã hoá; credential dùng chung trên Team/Enterprise nghĩa là mọi thành viên dùng connector đều mang quyền của credential đó — nên giới hạn scope credential tối thiểu.
- Chỉnh sửa custom connector = xoá rồi thêm lại; revoke quyền bằng disconnect ở Claude settings hoặc security settings của dịch vụ.
- Phát hiện server độc: Anthropic có kênh report malicious MCP servers; connector vào directory phải qua review criteria (tool design, prompt-injection patterns).

## Liên hệ với MCP connector của API

Nếu sau này cần dùng từ phía code: đây cùng họ công nghệ nhưng là tính năng API riêng. `mcp_servers` + `mcp_toolset` trong Messages API cho phép gắn remote MCP server vào từng request mà không cần tự viết MCP client, beta header hiện tại là `mcp-client-2025-11-20`, hỗ trợ Claude API / AWS Bedrock / Microsoft Foundry (đều beta, ZDR not-eligible). Tính năng chat-side (Connectors Directory) và API-side (MCP connector) đều quy về remote MCP servers — một server MCP build đúng có thể phục vụ cả hai kênh.

## Bước tiếp theo

1. Nếu muốn dùng ngay: mở **Customize > Connectors** trên claude.ai, bật Google Workspace hoặc connector bạn cần, thử một request read-only trước (ví dụ tìm email) rồi mới bật write.
2. Nếu muốn kết nối hệ thống nội bộ: build remote MCP server (docs `connectors/building`), expose qua public URL + allowlist Anthropic IPs, hoặc deploy **MCP tunnels** nếu không muốn expose; thêm như custom connector.
3. Nếu đánh giá cho tổ chức: xem trước Software Directory Policy và bảng Verified/Community/Custom, quyết định chính sách "chỉ Verified", cấu hình Tool permissions (read-only trước), và cân nhắc Enterprise-managed auth nếu đã có IdP.

## Nguồn

- https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities
- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors
- https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude
- https://support.claude.com/en/articles/10166901-use-google-workspace-connectors
- https://support.claude.com/en/articles/12542951-set-up-the-microsoft-365-connector
- https://support.claude.com/en/articles/15537633-authorize-mcp-connectors-for-your-entire-organization
- https://claude.com/docs/connectors/getting-started
- https://claude.com/docs/connectors/verification
- https://claude.com/docs/connectors/building/directory-vs-custom
- https://claude.com/docs/llms.txt (index: connectors, mcp-tunnels, building, plugins)
- https://platform.claude.com/docs/en/agents-and-tools/mcp-connector

## Câu hỏi chưa giải quyết

- Không có. Phạm vi chốt với anh là Connectors trên Claude.ai; nếu anh muốn đi sâu phần build connector (submission, review criteria, MCP Apps SDK) thì báo em mở research tiếp theo.
