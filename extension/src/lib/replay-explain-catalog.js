// extension/src/lib/replay-explain-catalog.js —— 回放失败的错误码目录（纯数据，零依赖）。
//
// 单一职责：一张稳定目录 + 码归一。code → { code, category, title, detail, hint,
// remediation, severity, retriable, needsHuman, sideEffectPossible }。
// replay-explain.js 在这张表之上做分类/解释/报告；其它模块只依赖本文件也能拿到码表。
//
// 不变量：
//   - 条目形状固定（entry() 统一构造），severity/retriable/needsHuman/sideEffectPossible
//     必须显式或走安全默认：默认不可重试、不需要人工、不会已产生副作用；
//   - remediation 有界（≤ EXPLAIN_LIMITS.maxRemediation 条）；
//   - code 归一（canonicalCode）只做“别名 → 目录码”，不发明新语义。

/** 输出上限。 */
export const EXPLAIN_LIMITS = Object.freeze({
  maxText: 300,
  maxDetail: 500,
  maxRemediation: 6,
  maxEvidence: 12,
  maxFailures: 200,
  maxReportLines: 40,
});

/** 目录条目构造器（内部）：统一字段，避免条目形状漂移。 */
function entry(code, category, title, detail, hint, remediation, flags = {}) {
  return Object.freeze({
    code,
    category,
    title,
    detail,
    hint,
    remediation: Object.freeze(remediation.slice(0, EXPLAIN_LIMITS.maxRemediation)),
    severity: flags.severity || 'error',
    retriable: flags.retriable === true,
    needsHuman: flags.needsHuman === true,
    sideEffectPossible: flags.sideEffectPossible === true,
  });
}

/**
 * 稳定错误码目录。code → 条目。
 * 语义：retriable 只在“重试不会造成额外副作用”时为 true；needsHuman 表示必须人工介入；
 * sideEffectPossible 表示失败点可能已经产生了服务端/页面副作用（不能盲目重跑）。
 */
export const REPLAY_ERROR_CODES = Object.freeze({
  // --- 边界（replay-boundary / replay-boundary-plan） ---
  BOUNDARY_DOCUMENT_CHANGED: entry(
    'BOUNDARY_DOCUMENT_CHANGED', 'boundary',
    '文档已变化，录制窗口失效',
    '回放时 documentId 与录制不一致：SPA 重渲染/导航都可能导致。元素引用不能跨文档复用。',
    '先导航回录制 URL 并等文档稳定，再重新绑定目标；不要用当前页面硬跑。',
    ['导航到录制 URL（plan.boundaries 里的 navigate 动作）', '等待 documentId 稳定后重新采样身份', '重新执行目标还原（plan.targets）'],
    { retriable: true },
  ),
  BOUNDARY_FRAME_CHANGED: entry(
    'BOUNDARY_FRAME_CHANGED', 'boundary',
    'iframe 已变化，录制帧失效',
    '录制发生在某个 iframe 里，回放时该帧不存在或换了父帧；跨帧的元素引用不可复用。',
    '按录制顺序切回对应帧；帧不存在时重新录制该段，不要改点到父页面。',
    ['按 plan.boundaries 的 frame-switch 切回录制帧', '确认帧 URL 与录制一致', '帧缺失则重新录制该段'],
    { retriable: true },
  ),
  BOUNDARY_REVISION_CHANGED: entry(
    'BOUNDARY_REVISION_CHANGED', 'boundary',
    'DOM 代数已推进，元素引用需重建',
    '同一文档内 DOM 已重渲染（revision 变化），录制时的节点引用/快照可能已失效。',
    '按目标还原计划重新绑定元素；只读步骤可以继续，写入步骤必须先确认目标唯一。',
    ['重新绑定目标（replay-target）', '写入前确认目标唯一且可见', '必要时重新录制该段'],
    { retriable: true },
  ),
  BOUNDARY_URL_CHANGED: entry(
    'BOUNDARY_URL_CHANGED', 'boundary',
    '路由已变化，元素引用需重建',
    '同一文档内 URL/路由变化（SPA 软导航），页面内容可能已替换。',
    '按录制 URL 判断是否需要回到目标路由；不要假设旧元素还在。',
    ['确认当前路由与录制路由的关系', '必要时导航回录制路由', '重新绑定目标'],
    { retriable: true },
  ),
  BOUNDARY_MISSING: entry(
    'BOUNDARY_MISSING', 'boundary',
    '缺少文档身份，无法证明同窗口',
    '录制或当前窗口至少一侧没有 documentId，无法证明“在同一个文档里”。',
    '补采当前 documentId；或显式用宽松模式继续并接受风险。',
    ['采样当前 documentId（Page.getFrameTree + documentElement）', '确认未注入 synthetic documentId', '严格模式外再回放'],
    { sideEffectPossible: true },
  ),
  BOUNDARY_URL_MISSING: entry(
    'BOUNDARY_URL_MISSING', 'boundary',
    '换文档但没有可导航 URL',
    '录制里这处换文档没有记下 URL，回放无法证明该去哪一页。',
    '重新录制该次导航，或手动提供 url 覆盖；绝不拿“当前页面/最后已知 URL”去猜。',
    ['重新录制包含导航的那一段', '或显式提供 URL 覆盖', '确认目标页确实可直达'],
  ),
  BOUNDARY_FRAME_UNAVAILABLE: entry(
    'BOUNDARY_FRAME_UNAVAILABLE', 'boundary',
    '录制的 iframe 当前不存在',
    '录制所在的帧在当前帧树里找不到（可能被移除或换了 URL）。',
    '刷新页面后重试，或重新录制该帧内的步骤。',
    ['刷新页面并重新枚举帧树', '确认该 iframe 仍会被加载', '否则重新录制'],
    { retriable: true },
  ),
  BOUNDARY_TAB_MISSING: entry(
    'BOUNDARY_TAB_MISSING', 'boundary',
    'tab 切换无法还原',
    '录制包含 tab/window 切换，但缺少 tabId 或当前不允许切换。',
    '补齐 tabId，或改成在同一 tab 内重录该段。',
    ['检查录制事件里的 tabId', '按录制顺序切回目标 tab', '或重录为单 tab 流程'],
  ),
  BOUNDARY_CURRENT_UNKNOWN: entry(
    'BOUNDARY_CURRENT_UNKNOWN', 'boundary',
    '当前窗口身份未知',
    '计划生成时没有当前 documentId/frameId 证据，只能在运行期先采样。',
    '执行前先读一次当前文档身份，再决定从哪一步继续。',
    ['采样当前 documentId/frameId', '用 resumeFromBoundary 定位起点', '按计划继续'],
    { retriable: true },
  ),
  BOUNDARY_NAVIGATION_REQUIRED: entry(
    'BOUNDARY_NAVIGATION_REQUIRED', 'boundary',
    '需要先导航再继续',
    '计划在当前位置之后要换文档，继续执行前必须完成导航。',
    '先执行计划里的 navigate 动作，等 load 完成后再继续。',
    ['执行 navigate', '等待文档稳定（load/readyState）', '重新采样身份后继续'],
    { retriable: true },
  ),
  BOUNDARY_STALE_DOCUMENT: entry(
    'BOUNDARY_STALE_DOCUMENT', 'boundary',
    '目标元素来自已失效的文档',
    '目标快照/引用采集自旧文档，当前文档已不是它。',
    '重新采集快照并重做目标还原。',
    ['重新采集当前文档快照', '重新运行 replay-target', '确认绑定唯一'],
    { retriable: true },
  ),

  // --- 目标还原（replay-target） ---
  TARGET_NOT_FOUND: entry(
    'TARGET_NOT_FOUND', 'target',
    '目标元素找不到',
    '用录制时的定位信息（selector/name/text/role）在当前快照里没有命中任何节点。',
    '确认页面已到录制时的状态；元素可能改名/改结构，需要重新录制或人工指定。',
    ['确认页面状态与录制一致', '检查快照是否覆盖该文档/帧', '重新录制该步骤或人工指定目标'],
    { retriable: true },
  ),
  TARGET_AMBIGUOUS: entry(
    'TARGET_AMBIGUOUS', 'target',
    '目标多命中，拒绝猜测',
    '同一组定位信息命中了多个节点，且分数接近，无法证明该点哪一个。',
    '提高定位特异性（selector/role+name），或人工确认唯一目标；不要随机选第一个。',
    ['用 selector 替换文本定位', '人工确认目标后写入更精确的 target', '缩小快照范围到具体帧/区域'],
  ),
  TARGET_ANONYMOUS: entry(
    'TARGET_ANONYMOUS', 'target',
    '目标是匿名的，无法还原',
    'target 里没有任何可重新定位的信息（无 selector/id/name/text/role），回放不能猜。',
    '重新录制该动作，或在 target 里补 selector/name。',
    ['重新录制该动作', '为 target 补 selector 或可读 name', '对裸布局元素改用坐标点击并显式标注'],
  ),
  TARGET_NO_SNAPSHOT: entry(
    'TARGET_NO_SNAPSHOT', 'target',
    '缺少该文档/帧的快照',
    '计划要求验证目标可还原，但没有对应 document+frame 的快照。',
    '先采集快照再生成/校验计划；或使用静态候选模式（不做验证）。',
    ['采集当前 document+frame 快照', '按 boundaryScopeKey 建立快照索引', '重新生成计划'],
    { retriable: true },
  ),
  TARGET_EMPTY_SNAPSHOT: entry(
    'TARGET_EMPTY_SNAPSHOT', 'target',
    '快照为空',
    '对应文档/帧的快照里没有任何节点（页面未渲染完或被策略拦截）。',
    '等页面渲染完成再采样；确认没有被 CSP/风控拦成空白页。',
    ['等待渲染完成', '确认页面不是空白/拦截页', '重新采样快照'],
    { retriable: true },
  ),
  TARGET_ONLY_HIDDEN: entry(
    'TARGET_ONLY_HIDDEN', 'target',
    '目标只在隐藏节点里命中',
    '匹配到的节点 visible=false（display:none/收起面板等），直接操作不会生效。',
    '先让元素可见（展开/滚动/等动画），再重新绑定。',
    ['展开容器或滚动到可视区', '等待动画结束', '重新绑定目标'],
    { retriable: true },
  ),
  TARGET_UNSTABLE_SELECTOR: entry(
    'TARGET_UNSTABLE_SELECTOR', 'target',
    '选择器不稳定',
    'selector 依赖 nth-child/散列 class/随机 id，页面一改版就会失效。',
    '改用 role+name、data-testid 或稳定 id；把不稳定 selector 只当后备。',
    ['补充 data-testid/role+name 定位', '重新录制以采集语义描述符', '保留 selector 作为最后后备'],
  ),
  TARGET_STALE_DOCUMENT: entry(
    'TARGET_STALE_DOCUMENT', 'target',
    '目标绑定时文档已换',
    '目标还原结果属于旧文档/旧 revision，执行时已失效。',
    '在写入前重新采样身份与快照，确认仍在同一窗口。',
    ['写入前重新采样 documentId', '重新绑定目标', '必要时重新从边界还原开始'],
    { sideEffectPossible: true },
  ),
  TARGET_HUMAN_REQUIRED: entry(
    'TARGET_HUMAN_REQUIRED', 'human',
    '目标需要人工补值',
    '该步骤是 human-gate（密码/验证码/文件等），录制没有也不应该有可回放的值。',
    '暂停回放，等人工补值/确认后再继续。',
    ['暂停并等待人工输入', '确认人工值只进内存不进日志', '继续回放'],
    { needsHuman: true },
  ),

  // --- 差异校验（replay-diff） ---
  DIFF_EXPECTATION_FAILED: entry(
    'DIFF_EXPECTATION_FAILED', 'diff',
    '回放结果与录制预期不一致',
    'step.expect 校验失败：页面/接口的实际结果与录制时不一致。',
    '先判断是“预期本身过时”还是“回放没生效”；不要直接忽略失败继续跑。',
    ['查看 differences 的首个字段', '确认录制后页面逻辑/数据是否变化', '必要时更新录制或修正预期'],
    { sideEffectPossible: true },
  ),
  DIFF_MISSING_ACTUAL: entry(
    'DIFF_MISSING_ACTUAL', 'diff',
    '缺少实际观测，无法判决',
    '执行侧没有回传结果事实（ok/status/text/…），无法验证这一步。',
    '让执行侧回传结果事实，或把该步骤标为不验证。',
    ['检查执行结果是否被丢弃', '补采结果事实', '重新执行该步'],
    { retriable: true },
  ),
  DIFF_UNSUPPORTED_EXPECTATION: entry(
    'DIFF_UNSUPPORTED_EXPECTATION', 'diff',
    '存在未支持的预期字段',
    'expect 里出现了校验器不认识的键，已按警告处理（没有静默忽略）。',
    '把未知键改成受支持的校验形状，或确认它确实不需要校验。',
    ['对照 replay-diff 支持的 expect 键', '改写 expect 形状', '重新生成计划'],
    { severity: 'warning', retriable: true },
  ),
  DIFF_OBSERVATION_CHANGED: entry(
    'DIFF_OBSERVATION_CHANGED', 'diff',
    '观测内容发生变化',
    'observe 步骤的前后文本差异超出预期；如果这是动作副作用则属正常。',
    '确认变化是否由本步动作引起；无关变化说明页面有其他并发更新。',
    ['检查 hunks 里的增删行', '确认变化是否本步引起', '必要时把该步标成 warn 级'],
    { severity: 'warning', retriable: true },
  ),
  DIFF_OUTCOME_ERROR: entry(
    'DIFF_OUTCOME_ERROR', 'diff',
    '执行结果报错',
    '执行侧返回 ok=false 或携带 error，本步没有正常完成。',
    '按错误类型走重试/人工/重录流程；注意失败前是否已产生副作用。',
    ['读取原始 error 文案', '判断是否已产生副作用', '再决定重试或重录'],
    { sideEffectPossible: true },
  ),

  // --- 计划（replay-plan） ---
  PLAN_BLOCKED: entry(
    'PLAN_BLOCKED', 'plan',
    '计划存在阻断项，不能回放',
    '计划生成时发现至少一个必须先解决的问题（边界/目标/人工值/网络请求）。',
    '先按 blockers 逐条修复；不要跳过阻断项直接执行。',
    ['查看 blockers 的 code 与 index', '按 code 对应建议修复', '重新生成计划并确认 ok=true'],
  ),
  PLAN_EMPTY: entry(
    'PLAN_EMPTY', 'plan',
    '没有可回放的步骤',
    '输入是空录制/空程序，或全部步骤都被过滤掉。',
    '确认录制确实产生了步骤；空录制无法回放。',
    ['检查录制事件是否上报', '确认程序摘要非空', '重新录制'],
  ),
  PLAN_DUPLICATE: entry(
    'PLAN_DUPLICATE', 'plan',
    '同一计划已回放过',
    '计划的幂等 token 命中已知回放记录（同一录制程序重复执行）。',
    '确认确实要重复执行副作用；是则显式 allowDuplicate。',
    ['确认重复执行意图', '传入 allowDuplicate 或新 salt', '重新生成计划'],
    { sideEffectPossible: true },
  ),
  PLAN_TOO_LARGE: entry(
    'PLAN_TOO_LARGE', 'plan',
    '计划步骤超过上限',
    '录制/展开后的步骤数量超过回放上限，已或将要被截断。',
    '拆分录制程序或提高上限（需明确风险）；不要静默截断后继续。',
    ['拆分程序', '检查 loop/repeat 是否异常膨胀', '必要时调整 limits'],
  ),
  PLAN_SIDE_EFFECT: entry(
    'PLAN_SIDE_EFFECT', 'plan',
    '包含非幂等副作用步骤',
    '计划里有提交/删除/写入类动作，重跑可能造成重复副作用。',
    '确认目标状态（先 observe 对账），显式 allowNonIdempotent 后再执行。',
    ['先观察当前状态确认未执行', '确认副作用可接受', '显式允许非幂等后执行'],
    { sideEffectPossible: true },
  ),
  PLAN_HUMAN_REQUIRED: entry(
    'PLAN_HUMAN_REQUIRED', 'human',
    '需要人工补值才能继续',
    '计划里存在 human-gate 且缺少可回放的值。',
    '暂停回放，等人工补值；人工值不应写进日志/导出。',
    ['暂停等待人工输入', '确认值不落盘', '继续执行'],
    { needsHuman: true, sideEffectPossible: true },
  ),
  PLAN_RETRY_BUDGET: entry(
    'PLAN_RETRY_BUDGET', 'plan',
    '重试预算超限',
    '计划里的自动重试总次数超过回放预算，可能掩盖真实失败。',
    '减少 retry 配置或提高预算；不要靠无限重试“跑通”。',
    ['检查 fallback.retries 配置', '把可重试限制在只读步骤', '重算预算'],
  ),
  PLAN_VALIDATION: entry(
    'PLAN_VALIDATION', 'plan',
    '计划校验未通过',
    '输入程序本身有结构问题（缺 method、branch 无 URL、loop 过长等）。',
    '先修程序/录制，再生成回放计划。',
    ['按 validation 的 index/message 修录制', '重新构建程序', '重新预检'],
  ),
  PLAN_INVALID_INPUT: entry(
    'PLAN_INVALID_INPUT', 'plan',
    '回放输入非法',
    '调用方传入的参数形状不对（缺 tabId/url、overrides 类型错误等）。',
    '修正调用参数；错误码应与协议 schema 对齐。',
    ['对照命令参数 schema', '补齐必填参数', '重试'],
  ),
  PLAN_LOOP_CLAMPED: entry(
    'PLAN_LOOP_CLAMPED', 'plan',
    '循环次数被截断',
    'loop/repeat 次数超过上限，已按上限截断。',
    '确认录制里的重复是否真实；异常重复通常意味着录制器抖动。',
    ['检查重复步骤来源', '必要时重新录制', '显式调整 maxLoopIterations'],
    { severity: 'warning', retriable: true },
  ),
  PLAN_WAIT_CAPPED: entry(
    'PLAN_WAIT_CAPPED', 'plan',
    '等待时长被截断',
    '计划的总等待/单次等待超过上限，已截断时间线。',
    '确认是真实等待还是录制间隔噪声；截断可能导致页面未就绪。',
    ['检查 wait 来源', '必要时拆分步骤', '显式调整 maxWaitMs'],
    { severity: 'warning', retriable: true },
  ),

  // --- 网络回放（network.replay） ---
  NETWORK_REPLAY_BAD_URL: entry(
    'NETWORK_REPLAY_BAD_URL', 'network',
    '重放 URL 非法',
    'network.replay 需要绝对 HTTP(S) URL；相对路径、data:/file: 或超长 URL 都不支持。',
    '提供完整的 http(s) URL，或从录制请求里取原始 URL。',
    ['检查 request.url', '补全为绝对 URL', '重试'],
  ),
  NETWORK_REPLAY_BAD_METHOD: entry(
    'NETWORK_REPLAY_BAD_METHOD', 'network',
    '重放方法非法',
    'HTTP 方法不在支持列表（GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS）内。',
    '改用受支持的方法；不要把自定义方法当 GET 发。',
    ['检查 request.method', '改为受支持方法', '重试'],
  ),
  NETWORK_REPLAY_BODY_UNSAFE: entry(
    'NETWORK_REPLAY_BODY_UNSAFE', 'network',
    '重放正文不可安全复用',
    '请求正文被截断/是二进制 multipart/已脱敏，直接重放会产生错误请求。',
    '提供完整文本正文覆盖；二进制/表单上传请走原业务流程。',
    ['提供完整 body 覆盖', '确认内容类型是文本', '或改用浏览器内原流程复现'],
  ),
  NETWORK_REPLAY_REDACTED: entry(
    'NETWORK_REPLAY_REDACTED', 'network',
    '重放内容包含脱敏占位',
    'body/headers 里有 [redacted] 之类的占位符，说明录制时被脱敏，不能直接重放。',
    '由调用方提供真实值覆盖（不要写进日志），或放弃该请求的重放。',
    ['提供真实值覆盖', '确认值不落盘', '重试'],
    { needsHuman: true },
  ),
  NETWORK_REPLAY_CROSS_ORIGIN: entry(
    'NETWORK_REPLAY_CROSS_ORIGIN', 'network',
    '跨源重放需要显式允许',
    '重放目标与当前页面不同源，浏览器的同源/CORS 策略会让结果不可信。',
    '在目标源页面内重放，或显式确认跨源行为；不要把 CORS 失败当业务失败。',
    ['切到同源页面重放', '或显式允许跨源并标注风险', '确认响应可读'],
    { sideEffectPossible: true },
  ),
  NETWORK_REPLAY_MISSING_ENTRY: entry(
    'NETWORK_REPLAY_MISSING_ENTRY', 'network',
    '找不到要重放的录制请求',
    'network.replay 的 id 在当前 tab 的网络采集里不存在（未 start/已 stop/被淘汰）。',
    '先 network start 复现，或直接用 request 覆盖对象重放。',
    ['确认采集处于 active', '用 network.list 找到有效 id', '或用 request 覆盖重放'],
  ),
  NETWORK_REPLAY_CAPTURE_REQUIRED: entry(
    'NETWORK_REPLAY_CAPTURE_REQUIRED', 'network',
    '需要先开始网络采集',
    '该 tab 没有网络采集记录；network.replay 只能重放采集到的请求。',
    '先 network start，复现一次后立即 replay。',
    ['network start', '复现请求', 'network.replay'],
    { retriable: true },
  ),
  NETWORK_REPLAY_LIMIT: entry(
    'NETWORK_REPLAY_LIMIT', 'network',
    '重放次数/大小超限',
    '单次捕获内的重放次数或请求大小超过限制。',
    '拆分批次或减少重放；不要无界重放。',
    ['减少重放数量', '确认单次请求大小在限内', '重试'],
  ),
  NETWORK_REPLAY_HEADER_IGNORED: entry(
    'NETWORK_REPLAY_HEADER_IGNORED', 'network',
    '部分请求头被忽略',
    'cookie/host/content-length 等浏览器保留头不能透传，重放时由浏览器自己生成。',
    '确认业务不依赖这些头的原值；需要鉴权时改用页面内同源重放。',
    ['检查是否依赖被忽略的头', '必要时在页面内发起请求', '重试'],
    { severity: 'warning', retriable: true },
  ),

  // --- 校验（replay-verify） ---
  VERIFY_PLAN_SHAPE: entry(
    'VERIFY_PLAN_SHAPE', 'verify',
    '计划结构不合法',
    '计划缺字段、step 顺序错乱、human 步骤缺失等结构问题。',
    '重新生成计划；结构问题不要靠运行期兜底。',
    ['重新 buildReplayPlan', '检查 validatePlanShape 的 issues', '修复输入后重试'],
  ),
  VERIFY_ORDER: entry(
    'VERIFY_ORDER', 'verify',
    '执行顺序与计划不一致',
    '实际执行顺序偏离计划（跳步/乱序/重复执行）。',
    '按计划的 index 顺序执行；乱序会破坏边界与副作用语义。',
    ['对齐执行器与计划的 index', '检查并发执行', '重新执行'],
    { sideEffectPossible: true },
  ),
  VERIFY_COVERAGE: entry(
    'VERIFY_COVERAGE', 'verify',
    '执行覆盖不完整',
    '计划里有步骤没有结果，或多出计划外结果。',
    '补齐缺失步骤或清理额外执行；覆盖缺口会让“成功”不可信。',
    ['对比 plan.steps 与 outcomes', '补执行缺失步骤', '清理额外调用'],
  ),
  VERIFY_CHECKSUM: entry(
    'VERIFY_CHECKSUM', 'verify',
    '计划校验和变化',
    '计划在生成后被执行前被改动（或 token/fingerprint 不一致）。',
    '重新生成计划并以最终计划为准；不要手改 token。',
    ['重新生成计划', '比较指纹', '重试'],
  ),
  VERIFY_DETERMINISM: entry(
    'VERIFY_DETERMINISM', 'verify',
    '计划不确定（两次生成不一致）',
    '同一输入两次构建出的计划指纹/顺序不同，说明有隐藏的非确定因素。',
    '定位不稳定来源（时间戳、随机 id、Map 顺序）后修复；不要放行。',
    ['比较两次 steps', '检查输入里的时钟/随机值', '修复后重跑 verifyDeterminism'],
  ),
  VERIFY_TARGET_PLAN: entry(
    'VERIFY_TARGET_PLAN', 'verify',
    '目标计划结构不合法',
    '目标计划与步骤数量不一致、状态未知或 blocker 缺失。',
    '重新运行 replay-target 生成计划。',
    ['重新 planTargetRestoration', '检查 steps 数量', '重试'],
  ),

  // --- 运行时 ---
  REPLAY_INTERRUPTED: entry(
    'REPLAY_INTERRUPTED', 'runtime',
    '回放被中断',
    '回放过程被打断（页面关闭/调试器断开/人工接管）。',
    '确认中断点与已产生的副作用，再从中断点恢复。',
    ['检查已完成步骤', '确认页面仍在', '从检查点 resumePlan 恢复'],
    { sideEffectPossible: true },
  ),
  REPLAY_CANCELLED: entry(
    'REPLAY_CANCELLED', 'runtime',
    '回放被取消',
    '调用方主动取消；取消前可能已经执行了部分步骤。',
    '按已完成步骤对账，不要假设“取消=没执行”。',
    ['查看已完成步骤', '对账副作用', '必要时重新回放'],
    { sideEffectPossible: true },
  ),
  REPLAY_TIMEOUT: entry(
    'REPLAY_TIMEOUT', 'runtime',
    '回放超时',
    '等待页面/元素/响应超时。超时不等于失败，也不等于没执行。',
    '先观察页面对账，再决定重试；对写入步骤尤其要小心。',
    ['观察当前页面状态', '确认动作是否已生效', '再决定重试/跳过'],
    { retriable: true, sideEffectPossible: true },
  ),
  REPLAY_NOT_ATTEMPTED: entry(
    'REPLAY_NOT_ATTEMPTED', 'runtime',
    '回放未开始',
    '前置检查（计划/身份/参数）未通过，实际没有执行任何步骤。',
    '按前置失败的说明先修复；此时没有副作用风险。',
    ['修复前置失败', '重新生成计划', '重新执行'],
  ),
  REPLAY_INTERNAL: entry(
    'REPLAY_INTERNAL', 'internal',
    '回放内部错误',
    '未归类的内部异常（非预期状态）。',
    '保留原始错误信息与计划 token，按内部缺陷处理；不要静默吞掉。',
    ['保留原始 error/stack', '记录 plan token', '按内部缺陷修复'],
  ),
});

/** 目录码 → 条目；未知码返回 null。 */
export function getErrorEntry(code) {
  return REPLAY_ERROR_CODES[String(code || '')] || null;
}

/** 目录里所有码（稳定排序）。 */
export function catalogCodes() {
  return Object.keys(REPLAY_ERROR_CODES).sort();
}

/** 目录按大类分组（文档/测试用）。 */
export function catalogByCategory() {
  const out = {};
  for (const code of catalogCodes()) {
    const item = REPLAY_ERROR_CODES[code];
    if (!out[item.category]) out[item.category] = [];
    out[item.category].push(code);
  }
  return out;
}

/**
 * 其它模块的码 → 目录码。record-program 的 PROGRAM_CODES / replay-plan 的 PLAN_CODES
 * / replay-target / replay-diff / replay-verify 的码优先直接命中目录，否则走别名表。
 */
const CODE_ALIASES = Object.freeze({
  // record-program.js PROGRAM_CODES
  REPLAY_EMPTY: 'PLAN_EMPTY',
  REPLAY_DUPLICATE: 'PLAN_DUPLICATE',
  REPLAY_SIDE_EFFECT: 'PLAN_SIDE_EFFECT',
  REPLAY_HUMAN_REQUIRED: 'PLAN_HUMAN_REQUIRED',
  REPLAY_RETRY_BUDGET: 'PLAN_RETRY_BUDGET',
  REPLAY_LOOP: 'PLAN_LOOP_CLAMPED',
  REPLAY_VALIDATION: 'PLAN_VALIDATION',
  // replay-plan.js PLAN_CODES
  PLAN_HUMAN_VALUE_MISSING: 'PLAN_HUMAN_REQUIRED',
  PLAN_BOUNDARY_UNRESTORABLE: 'PLAN_BLOCKED',
  PLAN_TARGET_UNRESOLVED: 'PLAN_BLOCKED',
  PLAN_NETWORK_REQUEST: 'NETWORK_REPLAY_BAD_URL',
  PLAN_TRUNCATED: 'PLAN_TOO_LARGE',
  // replay-target.js TARGET_CODES
  TARGET_EXACT_SELECTOR: 'TARGET_NOT_FOUND',
  TARGET_UNIQUE_MATCH: 'TARGET_NOT_FOUND',
  TARGET_GEOMETRY_TIEBREAK: 'TARGET_AMBIGUOUS',
  TARGET_SCORE_MARGIN: 'TARGET_AMBIGUOUS',
  TARGET_NO_MATCH: 'TARGET_NOT_FOUND',
  TARGET_INVALID_DESCRIPTOR: 'TARGET_ANONYMOUS',
  TARGET_NOT_REQUIRED: 'REPLAY_NOT_ATTEMPTED',
  // replay-diff.js DIFF_CODES
  DIFF_OK: 'REPLAY_NOT_ATTEMPTED',
  DIFF_URL_MISMATCH: 'DIFF_EXPECTATION_FAILED',
  DIFF_VALUE_MISMATCH: 'DIFF_EXPECTATION_FAILED',
  DIFF_TEXT_MISMATCH: 'DIFF_EXPECTATION_FAILED',
  DIFF_TEXT_WARNING: 'DIFF_EXPECTATION_FAILED',
  DIFF_STATUS_MISMATCH: 'DIFF_EXPECTATION_FAILED',
  DIFF_COUNT_MISMATCH: 'DIFF_EXPECTATION_FAILED',
  DIFF_ATTRIBUTE_MISMATCH: 'DIFF_EXPECTATION_FAILED',
  DIFF_EXISTS_MISMATCH: 'DIFF_EXPECTATION_FAILED',
  DIFF_VISIBILITY_MISMATCH: 'DIFF_EXPECTATION_FAILED',
  DIFF_ENABLED_MISMATCH: 'DIFF_EXPECTATION_FAILED',
  DIFF_SHAPE_MISMATCH: 'DIFF_EXPECTATION_FAILED',
  DIFF_SNAPSHOT_CHANGED: 'DIFF_OBSERVATION_CHANGED',
  DIFF_NUMERIC_TOLERATED: 'DIFF_EXPECTATION_FAILED',
  // replay-verify.js VERIFY_CODES
  VERIFY_PLAN: 'VERIFY_PLAN_SHAPE',
  VERIFY_PLAN_DETERMINISM: 'VERIFY_DETERMINISM',
  VERIFY_TARGET: 'VERIFY_TARGET_PLAN',
  // 边界/目标模块里少量直接码
  BOUNDARY_NAVIGATION_FAILED: 'BOUNDARY_NAVIGATION_REQUIRED',
  BOUNDARY_REPLAY_WINDOW_MATCHED: 'REPLAY_NOT_ATTEMPTED',
  BOUNDARY_DOCUMENT_CONFLICT: 'BOUNDARY_DOCUMENT_CHANGED',
  BOUNDARY_STEPS_TRUNCATED: 'PLAN_TOO_LARGE',
});

/** 码归一：直接命中目录 → 原码；否则查别名；都没有 → 原码（由调用方兜底）。 */
export function canonicalCode(code) {
  const text = String(code || '');
  if (!text) return '';
  if (REPLAY_ERROR_CODES[text]) return text;
  if (CODE_ALIASES[text]) return CODE_ALIASES[text];
  if (/^E_/.test(text)) return 'PLAN_INVALID_INPUT';
  return text;
}

// ---------------------------------------------------------------------------
// 脱敏
