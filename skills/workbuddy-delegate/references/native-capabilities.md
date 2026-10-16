# WorkBuddy Native Capabilities & Acceptance Reference

This reference catalogs WorkBuddy's nineteen specialized native capability domains and the concrete acceptance criteria required for each. Load this reference on-demand when scoping delegation objectives.

| Native Domain | Synthetic Input | Minimum Observable Acceptance Criteria |
|---|---|---|
| **创作文档** (Document Creation) | Synthetic sales data | `sales-report.docx`: opens in document viewer with correct heading, formatted table, and 450 total. |
| **金融服务** (Financial Analysis) | Fictitious company synthetic financial statements | Structured analysis document with verifiable formulas, identified risk factors, and explicit assumptions. No live transactions. |
| **深度研究** (Deep Research) | Public technical query | Research document with direct primary citations and traceable claims. Verified by manual spot-check against sources. |
| **策划方案** (Planning & Proposals) | Synthetic event background | Comprehensive proposal document with aligned objectives, timeline, responsibilities, and itemized budget. |
| **技术文档** (Technical Documentation) | Isolated module interface or API contract | Technical reference documentation accurately reflecting interface definitions and usage examples without altering source code. |
| **分析数据** (Data Analysis) | `sales.csv` | Verifiable spreadsheet or analytical report showing January=300, February=150, Product A=250, Product B=200. |
| **制作PPT** (Presentation Authoring) | `sales.csv` | Real two-slide `sales.pptx` with readable rendered slides and verified monthly/product totals. Renamed text files rejected. |
| **PPT设计** (Presentation Redesign) | Prior PPT snapshot + redesign instructions | New round `sales-redesign.pptx` preserving data while demonstrating layout/styling changes without text overflow. |
| **视觉海报** (Visual Posters) | Synthetic event brief | Real decodable image file matching required title, subject, and dimensions. HTML intermediate draft rejected. |
| **运营海报** (Marketing Graphics) | Promotional copy | Decodable marketing poster with legible price, dates, and call-to-action matching brief without rendering artifacts. |
| **品牌设计** (Brand Identity) | Fictitious brand brief | Viewable brand assets with consistent color palette, typography, and logo usage, distinguishing final assets from source materials. |
| **视频生成** (Video Generation) | Short video storyboard brief | Real playable video file with verifiable duration, visual sequence, and synchronized audio track. Text scripts or URL claims alone rejected. |
| **日常开发** (Routine Coding) | Pure function specification | Working source code in outputs directory verified by OMP executing test inputs before integration. |
| **开发网站** (Web Engineering) | Minimal web application spec | Runnable project in outputs directory launched and verified across critical paths via browser. Deployment requires separate consent. |
| **网站设计** (UI/UX Web Design) | Page design brief | Visible interactive UI/design deliverables verified by visual inspection rather than raw source inspection. |
| **小程序** (Mini-Programs) | Mini-program specification | Working project package verified via preview/developer tools executing designated user journeys. Platform submission requires separate consent. |
| **Agent应用开发** (Agent Development) | Synthetic agent workflow spec | Executable application exhibiting real tool invocation and responses for sample inputs. Cloud resource writes require separate consent. |
| **Skill** (Skill Authoring) | Custom skill specification | Functional `SKILL.md` and associated references, verified by loading in native environment and observing task routing. |
| **定时任务** (Scheduled Tasks) | One-time test schedule with confirmed parameters | Verified scheduled entry producing expected output at designated trigger time. Schedule cleanup requires human confirmation. |
