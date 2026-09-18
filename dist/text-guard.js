
/**
 * dsh-voice-local 文本幻觉兜底过滤（纯函数，/transcribe 出口处调用）。
 *
 * 背景：SenseVoice 类模型对非语音音频可能输出训练残留文本（"谢谢观看。"、
 * 字幕组署名、"Thank you."、单字符超长重复等）。守门管线（audio-filter）
 * 在音频侧拦截绝大多数非语音段；这里是最后一道文本保险丝。
 * 规则刻意保守——只拦"高置信幻觉"，正常中英文/混排一律直通（spec 场景：
 * "好的，明天见" 必须原样通过）。
 */

/** 整句级残留短语：剥除标点/空白并小写后精确比较。 */
const RESIDUAL_EXACT = new Set([
  // 中文视频残留
  '谢谢观看', '谢谢收看', '感谢观看', '感谢收看', '谢谢大家观看',
  // 英文 Whisper 系经典幻觉（条目为去空白形态，与 normalize 对齐）
  'thankyou', 'thanksforwatching', 'thankyouforwatching',
  'thankyouverymuch', 'pleasesubscribe',
]);

/** 前缀型残留（署名/字幕平台），限定形状防止误杀正常句。 */
const RESIDUAL_SHAPE = [
  /^字幕由.{0,40}(提供|制作|译制)[!！。.~～\s]*$/u,
  /^amara\.org.*$/u,
  /^subtitles?\s+(by|and\s+translation).*$/iu,
];

/** 剥除标点/符号/空白，用于匹配与重复度判定。 */
function stripNoise(text) {
  return text.replace(/[\p{P}\p{S}\s]+/gu, '');
}

/** 判定是否"单一短单元超长重复"（如 aaaaaa、哈哈哈哈……、啊啊啊啊……）。 */
function isRunawayRepeat(stripped) {
  if (stripped.length < 6) return false;
  return /^(.{1,3}?)\1+$/u.test(stripped);
}

/**
 * 净化识别文本（spec「识别结果回填输入框草稿」）：去除回车符、把换行折叠为空格。
 * 识别模型输出换行是有可能的；草稿里出现空行/控制字符会污染宿主 composer。
 * 保持纯函数，便于单测。
 * @param {string} text
 * @returns {string}
 */
export function sanitizeTranscript(text) {
  if (typeof text !== 'string') return '';
  // \r 直接去除（含 \r\n 的 \r）；连续 \n 折叠为单个空格。
  return text.replace(/\r/g, '').replace(/\n+/g, ' ');
}

/**
 * 幻觉兜底：返回清洗后的文本；判定为幻觉时返回空字符串。
 * @param {string} text
 * @returns {string}
 */
export function guardTranscript(text) {
  if (typeof text !== 'string') return '';
  const trimmed = sanitizeTranscript(text).trim();
  if (trimmed === '') return '';

  const stripped = stripNoise(trimmed);
  if (stripped === '') return '';               // 孤立标点/纯符号

  const normalized = stripped.toLowerCase();
  if (RESIDUAL_EXACT.has(normalized)) return ''; // 训练残留整句

  for (const re of RESIDUAL_SHAPE) {
    if (re.test(trimmed)) return '';
  }

  if (isRunawayRepeat(stripped)) return '';      // 异常超长重复

  return trimmed;                                 // 正常文本直通
}
