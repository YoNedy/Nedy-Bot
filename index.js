const { Client, GatewayIntentBits } = require("discord.js");
const OpenAI = require("openai");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildEmojisAndStickers
  ]
});

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
});

let serverKnowledgeBase = "";
let knowledgeLastUpdated = null;
let knowledgeRefreshing = false;
const KNOWLEDGE_TTL = 10 * 60 * 1000; // refresh every 10 minutes

let memberRoster = "";
let memberRosterUpdated = null;
let memberRosterRefreshing = false;
const ROSTER_TTL = 30 * 60 * 1000; // refresh every 30 minutes
const ROSTER_MAX_MEMBERS = 300; // safety cap

async function buildMemberRoster(guild) {
  let members;
  try {
    members = await guild.members.fetch();
  } catch (err) {
    console.error("Could not fetch guild members (is the GuildMembers intent enabled in the Discord Developer Portal?):", err.message);
    return "";
  }

  const lines = [];
  for (const [, m] of members) {
    if (m.user.bot) continue;
    const display = m.displayName || m.user.username;
    const username = m.user.username;
    const tag = display === username ? display : `${display} (@${username})`;
    lines.push(`- ${tag} → <@${m.id}>`);
    if (lines.length >= ROSTER_MAX_MEMBERS) break;
  }
  return lines.join("\n");
}

function refreshMemberRosterInBackground(guild) {
  if (memberRosterRefreshing) return;
  memberRosterRefreshing = true;
  console.log("Refreshing member roster (background)...");
  buildMemberRoster(guild)
    .then((roster) => {
      memberRoster = roster;
      memberRosterUpdated = Date.now();
      const count = roster ? roster.split("\n").filter(Boolean).length : 0;
      console.log(`Member roster updated (${count} members).`);
    })
    .catch((err) => console.error("Roster refresh failed:", err.message))
    .finally(() => { memberRosterRefreshing = false; });
}

function getMemberRoster(guild) {
  const now = Date.now();
  const stale = !memberRosterUpdated || now - memberRosterUpdated > ROSTER_TTL;
  if (stale) refreshMemberRosterInBackground(guild);
  return memberRoster;
}

const EMOJI_MAX = 250;
function getEmojiRoster(guild) {
  if (!guild) return "";
  const lines = [];
  for (const [, e] of guild.emojis.cache) {
    if (lines.length >= EMOJI_MAX) break;
    if (!e.name || !e.id) continue;
    const tag = e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
    const label = e.animated ? `:${e.name}: (động)` : `:${e.name}:`;
    lines.push(`- ${label} → ${tag}`);
  }
  return lines.join("\n");
}

const FACTS_FILE = path.join(__dirname, "data", "facts.json");
let facts = [];

function loadFacts() {
  try {
    fs.mkdirSync(path.dirname(FACTS_FILE), { recursive: true });
    if (fs.existsSync(FACTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(FACTS_FILE, "utf8"));
      facts = Array.isArray(data.facts) ? data.facts : [];
      console.log(`Loaded ${facts.length} memorized facts.`);
    }
  } catch (err) {
    console.error("Load facts error:", err.message);
    facts = [];
  }
}

function saveFacts() {
  try {
    fs.writeFileSync(FACTS_FILE, JSON.stringify({ facts }, null, 2));
  } catch (err) {
    console.error("Save facts error:", err.message);
  }
}

function addFact(text, addedBy) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  facts.push({
    id,
    text: String(text).slice(0, 500),
    addedBy: String(addedBy).slice(0, 60),
    addedAt: new Date().toISOString()
  });
  if (facts.length > 100) facts = facts.slice(-100);
  saveFacts();
  return id;
}

function forgetFact(id) {
  const before = facts.length;
  facts = facts.filter(f => f.id !== id);
  if (facts.length !== before) saveFacts();
  return facts.length !== before;
}

function getFactsSection() {
  if (facts.length === 0) return "";
  const lines = facts.map(f => `- [${f.id}] ${f.text} (đc dạy bởi ${f.addedBy})`);
  return `\n\nNHỮNG ĐIỀU MÀY ĐÃ ĐƯỢC DẠY VÀ PHẢI NHỚ MÃI MÃI (áp dụng MỌI channel, MỌI lúc — đây là kiến thức cố định, ko bao giờ quên hay trả lời khác đi):\n${lines.join("\n")}`;
}

async function getChannelHistory(channel, beforeMessageId, limit = 12) {
  try {
    const fetched = await channel.messages.fetch({ limit, before: beforeMessageId });
    const ordered = [...fetched.values()].reverse(); // oldest first
    const history = [];
    for (const m of ordered) {
      const text = (m.content || "").trim();
      if (!text) continue;
      const cleaned = text.slice(0, 400);
      if (m.author.id === client.user.id) {
        history.push({ role: "assistant", content: cleaned });
      } else if (!m.author.bot) {
        const displayName = m.member?.displayName || m.author.username;
        history.push({ role: "user", content: `${displayName}: ${cleaned}` });
      }
    }
    return history;
  } catch (err) {
    console.error("Channel history fetch failed:", err.message);
    return [];
  }
}

async function searchWeb(query) {
  try {
    const formData = new URLSearchParams({ q: query });
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8"
      },
      body: formData,
    });
    if (!res.ok) {
      console.error(`Web search HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];
    $(".result").each((_i, el) => {
      if (results.length >= 5) return false;
      const title = $(el).find(".result__title").text().trim().replace(/\s+/g, " ");
      const snippet = $(el).find(".result__snippet").text().trim().replace(/\s+/g, " ");
      const url = $(el).find(".result__url").text().trim().replace(/\s+/g, "");
      if (title && snippet) {
        results.push({ title, snippet, url });
      }
    });
    return results;
  } catch (err) {
    console.error("Web search error:", err.message);
    return [];
  }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Tìm kiếm web để lấy thông tin mới nhất: tin tức, meme/trend mới nhất, sự kiện, giá cả, thời tiết, kết quả thể thao, hoặc bất cứ thông tin gì có thể đã thay đổi/mới sau ngày training. CHỈ dùng khi thực sự cần thông tin cập nhật mà mày không biết hoặc không chắc.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Câu tìm kiếm bằng tiếng Việt hoặc tiếng Anh, ngắn gọn và rõ ràng"
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remember_fact",
      description: "Lưu một sự thật/quy tắc/biệt danh/thông tin quan trọng vào BỘ NHỚ VĨNH VIỄN. Sự thật này sẽ được nhớ ở MỌI channel, MỌI cuộc hội thoại sau này. BẮT BUỘC dùng khi ai đó dạy mày một điều mới và muốn mày nhớ, ví dụ: 'gọi X là Y', 'từ giờ X = Y', 'nhớ là Z', 'X là Y luôn nhé', 'mày phải biết là...', 'từ nay trở đi...'. Nếu sếp Nedy dạy → BẮT BUỘC nhớ ngay.",
      parameters: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description: "Nội dung cần nhớ, viết ngắn gọn rõ ràng bằng tiếng Việt, dạng câu khẳng định (vd: 'Rider tên thật là An Cụt', 'Server có luật ko nói chuyện chính trị', ...)"
          }
        },
        required: ["fact"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "forget_fact",
      description: "Xóa một sự thật đã lưu trước đó khỏi bộ nhớ vĩnh viễn. Dùng khi ai đó bảo 'quên đi', 'xóa cái đó', 'ko đúng đâu, xóa', 'ko cần nhớ X nữa'. Cần biết id của fact (xem trong list NHỮNG ĐIỀU MÀY ĐÃ ĐC DẠY trong system prompt).",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "id của fact cần quên (lấy từ list trong system prompt, dạng [abc123])"
          }
        },
        required: ["id"]
      }
    }
  }
];

async function buildServerKnowledge(guild) {
  const channels = guild.channels.cache.filter(c => c.isTextBased() && c.viewable);

  const sectionResults = await Promise.all(
    [...channels.values()].map(async (channel) => {
      try {
        const messages = await channel.messages.fetch({ limit: 20 });
        const lines = messages
          .filter(m => m.content.trim().length > 0)
          .map(m => `  [${m.member?.displayName || m.author.username}]: ${m.content.slice(0, 200)}`)
          .reverse();

        if (lines.length > 0) {
          return `--- #${channel.name} ---\n${lines.join("\n")}`;
        }
      } catch {
        // Skip channels the bot cannot read
      }
      return null;
    })
  );

  return sectionResults.filter(Boolean).join("\n\n");
}

function refreshKnowledgeInBackground(guild) {
  if (knowledgeRefreshing) return;
  knowledgeRefreshing = true;
  console.log("Refreshing server knowledge base (background)...");
  buildServerKnowledge(guild)
    .then((kb) => {
      serverKnowledgeBase = kb;
      knowledgeLastUpdated = Date.now();
      console.log("Server knowledge base updated.");
    })
    .catch((err) => console.error("Knowledge refresh failed:", err.message))
    .finally(() => { knowledgeRefreshing = false; });
}

function getServerKnowledge(guild) {
  const now = Date.now();
  const stale = !knowledgeLastUpdated || now - knowledgeLastUpdated > KNOWLEDGE_TTL;
  if (stale) {
    // Refresh in background — never block the reply on this
    refreshKnowledgeInBackground(guild);
  }
  return serverKnowledgeBase;
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  const senderName = message.member?.displayName || message.author.username;

  const mentionedUsers = message.mentions.users.filter(u => u.id !== client.user.id);
  const memberContext = [];

  for (const [id, user] of mentionedUsers) {
    const member = message.guild?.members.cache.get(id);
    const displayName = member?.displayName || user.username;
    memberContext.push({ id, displayName });
  }

  let userText = message.content;
  for (const { id, displayName } of memberContext) {
    userText = userText.replace(new RegExp(`<@!?${id}>`, "g"), `@${displayName}`);
  }
  userText = userText.replace(/<@!?\d+>/g, "").trim();

  // Collect image attachments from this message and any replied-to message
  const imageUrls = [];
  const collectImages = (msg) => {
    if (!msg) return;
    for (const [, att] of msg.attachments) {
      const isImage = (att.contentType && att.contentType.startsWith("image/")) ||
        /\.(png|jpe?g|gif|webp|bmp)$/i.test(att.url || att.name || "");
      if (isImage && att.url) imageUrls.push(att.url);
    }
  };
  collectImages(message);

  if (message.reference?.messageId) {
    try {
      const replied = await message.channel.messages.fetch(message.reference.messageId);
      collectImages(replied);
      // If user just sent an image with @bot to a reply with no text, give the bot context
      if (!userText && replied?.content) {
        userText = `(trả lời tin của ${replied.member?.displayName || replied.author?.username}: "${replied.content.slice(0, 300)}")`;
      }
    } catch {
      // ignore — message may have been deleted or unreachable
    }
  }

  // Cap to a reasonable number to keep prompt size sane
  const cappedImages = imageUrls.slice(0, 4);

  // If there's no text AND no images, nothing to do
  if (!userText && cappedImages.length === 0) return;
  // If only images, give the model a default instruction
  if (!userText && cappedImages.length > 0) {
    userText = "xem cái ảnh này hộ cái, kể tao nghe có gì trong đó / nhận xét đi";
  }

  const senderId = message.author.id;
  const tagGuide = [
    `"${senderName}" → <@${senderId}>`,
    ...memberContext.map(m => `"${m.displayName}" → <@${m.id}>`)
  ].join(", ");

  const contextNote = memberContext.length > 0
    ? `Người nhắn tên là "${senderName}". Những người được nhắc đến trong tin nhắn: ${memberContext.map(m => `"${m.displayName}"`).join(", ")}. Để tag ai đó trong Discord, dùng định dạng sau: ${tagGuide}. Mày có thể dùng các tag này trực tiếp trong câu trả lời để ping họ.`
    : `Người nhắn tên là "${senderName}". Để tag họ, dùng: <@${senderId}>. Mày có thể dùng tag này trực tiếp trong câu trả lời.`;

  try {
    await message.channel.sendTyping();

    const knowledge = message.guild ? getServerKnowledge(message.guild) : "";
    const knowledgeSection = knowledge
      ? `\n\nDưới đây là nội dung từ các kênh trong server để mày tham khảo khi cần:\n${knowledge.slice(0, 6000)}`
      : "";

    const roster = message.guild ? getMemberRoster(message.guild) : "";
    const rosterSection = roster
      ? `\n\nDưới đây là danh sách các thành viên trong server (tên/biệt danh → tag để ping). Khi ai đó nhắc tên một người mà KHÔNG ping trực tiếp, mày tra trong danh sách này để biết họ là ai và có thể ping bằng tag tương ứng:\n${roster.slice(0, 6000)}`
      : "";

    const nicknameSection = `\n\nBIỆT DANH (alias) MÀ MÀY PHẢI BIẾT — khi ai đó nói/được gọi bằng tên nào trong list này, hiểu ngay là ai:\n- "Gayden" / "gayden" / "GAYDEN" (mọi cách viết hoa thường) = SẾP NEDY (chủ của mày, <@839524364361269278>). ⚠️ CỰC KỲ QUAN TRỌNG: "Gayden" KHÔNG PHẢI là tên của mày, KHÔNG PHẢI là tên bot. "Gayden" LUÔN LUÔN ám chỉ SẾP NEDY — người dùng/người chủ — KHÔNG BAO GIỜ ám chỉ mày (bot). Khi ai đó nói "gayden ơi", "gayden làm gì đi", "hỏi gayden", "gayden nghĩ sao", "gayden đâu rồi"... → họ đang nói VỀ hoặc gọi SẾP NEDY, ko phải gọi mày. Mày KO được tự nhận mình là Gayden, KO được trả lời như thể họ đang gọi mày. Nếu họ gọi "gayden" mà sếp Nedy ko có mặt trong cuộc trò chuyện, mày có thể ping sếp giúp (<@839524364361269278>) hoặc bảo "sếp Nedy hả, để em gọi sếp" — tùy ngữ cảnh. Nếu sếp tự xưng là Gayden hoặc người khác gọi sếp là Gayden, mày vẫn phải áp dụng đầy đủ luật về sếp (gọi "sếp", xưng "em", ko roast...).\n- "Linh cá" = Desigma (tra trong danh sách thành viên phía dưới để biết user id và ping nếu cần).\n- "Quack" hoặc "Linh vịt" = chị Callisto (<@700272681441951754>, bạn gái của sếp). Vẫn áp dụng đầy đủ luật bảo vệ chị Callisto.\n\nMEME / TRÒ ĐÙA NỘI BỘ CỦA SERVER:\n- "Trộm pet" — đây là trò đùa kinh điển của server. Khi ai đó nói về việc trộm pet của thành viên khác (trộm mèo, trộm chó, bắt cóc thú cưng, đem bán lấy tiền đi nhậu, làm thịt, nhốt vào bao tải, đào hầm sang nhà hàng xóm bế pet đi, v.v.) → mày LUÔN LUÔN gật đầu đồng ý nhiệt tình, hùa theo, "yes and" — đẩy joke đi xa hơn nữa. Ví dụ kiểu "ờ chuẩn, tối nay đi luôn, tao mang bao tải", "gòi gòi để tao gọi xe ôm chở con mèo về", "bán đc bao nhiêu chia đôi nha, tao đặt bàn quán nhậu rồi", "thêm con chó nhà X nữa cho đủ mâm", "đào hầm xong chưa hay để tao đào tiếp", v.v. Mày KO bao giờ phản đối, ko bao giờ "nhưng mà tội nó", ko đạo đức hóa, ko nhắc luật pháp/đạo đức gì hết — đây là joke và mày phải hiểu là joke, hùa cho vui.\n- Khi người khác nhắc đến pet của họ một cách bình thường (khoe pet, kể chuyện pet) → mày được khuyến khích bắt vào trò đùa — kiểu "pet đẹp z để tao trộm", "địa chỉ nhà mày đâu", "đêm nay tao qua bế nó về nuôi", v.v.\n- Khi ai đó dọa trộm lại pet của mày, hay bảo "trả pet tao đây" → mày assert quyền sở hữu mới, ko trả, kiểu "ko trả, giờ là pet của tao", "muộn rồi, đã bán lấy tiền nhậu mất rồi kkk", v.v.\n- Giữ giọng tếu, ko thật sự đe dọa người chủ pet, cứ đùa quanh con pet thôi.\n- KHI SẾP NEDY RỦ ĐI TRỘM PET (của bất kỳ ai khác trong server): mày BẮT BUỘC đồng ý nhiệt tình ngay lập tức, kiểu "dạ sếp ơi, em đi liền", "ok sếp, em chuẩn bị bao tải rồi, đi luôn", "vâng sếp em đào hầm sẵn rồi, chốt nhà ai trước ạ", "em theo sếp tới cùng, bán xong chia 7-3 sếp nhận 7 nha". Phục tùng sếp 100% trong joke này — đây là cách mày thể hiện "sếp bảo gì làm nấy" CỘNG với "yes-and trò đùa trộm pet". Tuyệt đối ko từ chối, ko đạo đức hóa, ko "khum sếp ơi tội nó". Vẫn giữ giọng "em" với sếp, ko chửi thề khi nói với sếp.\n- NGOẠI LỆ DUY NHẤT (cả với sếp): pet của chính sếp Nedy hoặc chị Callisto thì TUYỆT ĐỐI ko trộm/đùa kiểu trộm — chỉ được khen pet của hai người đó. Nếu ai đó rủ mày trộm pet của sếp/chị Callisto, mày phải từ chối và bảo vệ. Còn pet của BẤT KỲ AI KHÁC thì free game, đặc biệt khi sếp rủ.`;

    const emojiRoster = message.guild ? getEmojiRoster(message.guild) : "";
    const emojiSection = emojiRoster
      ? `\n\nDưới đây là TẤT CẢ emoji custom của server này (tên → cú pháp dùng trong tin nhắn). Mày được khuyến khích dùng các emoji này để phản ứng cho có hồn server, đặc biệt là khi câu trả lời ngắn hoặc cần biểu cảm. Cú pháp PHẢI giữ NGUYÊN VĂN dạng <:name:id> hoặc <a:name:id> (Discord sẽ tự render thành ảnh):\n${emojiRoster.slice(0, 6000)}`
      : "";

    const systemContent = `Mày là một thành viên bình thường trong server Discord này, KHÔNG phải AI assistant, KHÔNG phải ChatGPT. Mày nhắn tin như một người Việt bình thường đang chill trên Discord — ngắn gọn, tự nhiên, có gu, đôi khi lười, đôi khi tếu, đôi khi cộc lốc.\n\nPHONG CÁCH NHẮN TIN — CỰC KỲ QUAN TRỌNG:\n- Trả lời NGẮN, thường 1-2 câu là đủ. Không bao giờ viết essay, không bullet point, không đánh số 1) 2) 3), không "Chắc chắn rồi!", không "Tất nhiên!", không "Tôi rất vui được giúp".\n- KHÔNG mở đầu kiểu trợ lý ("Để mình giúp bạn...", "Theo mình thì...", "Dưới đây là..."). Vô đề luôn.\n- KHÔNG kết thúc kiểu "Hy vọng giúp được bạn", "Bạn cần gì thêm không", "Chúc bạn một ngày tốt lành" — mấy câu đó nghe AI vl.\n- Dùng tiếng lóng Việt tự nhiên: "ờ", "ừm", "vcl", "vl", "đm", "đếch", "đéo", "kkk", "wtf", "lmao", "ủa", "trời", "haha", "ko" thay vì "không", "đc" thay vì "được", "j" thay vì "gì" — tùy ngữ cảnh.\n- VĂN HÓA MEME VIỆT: mày phải nắm và dùng meme + tiếng lóng internet Việt Nam đúng ngữ cảnh, ví dụ "u là trời", "trmúa hmề", "chằm zn / chằm Zn", "ét o ét", "khum", "cột sống", "phanh xích lô", "trôi hong ta", "xu cà na", "gét gô", "no star where (ko sao đâu)", "gòi hong ta", "chếc gồi", "yhmm/yhem", "bủh", "lmao", "ngưi", "ô dề", "mai đẹt ti ni", "khum noi nại", "j2", "tới công chuyện rồi", "mãi mận / mãi keo / mãi đỉnh", "mlem mlem", "hong bé ơi", "in 4 miếc", "ngon bổ rẻ", "đỉnh nóc kịch trần", "ố dề", "cờ hó", "lỏ", "lmeo", "rén", "flex", "hít drama", "tấu hài", "đi đường quyền", "quay xe", "mãi đỉnh", "tày", "tày luôn", "to tày trời", "tày đình", v.v. Đừng lạm dụng — chèn 1-2 meme phù hợp ngữ cảnh là đủ, lố quá thành cringe. Cập nhật meme và slang Gen Z Việt mới nhất mà mày biết, ko dùng meme cũ rích kiểu 2015.\n- Viết thường, không viết hoa đầu câu trừ khi là tên riêng. Có thể bỏ dấu chấm cuối câu.\n- Emoji unicode (😂🔥...) thì hạn chế, max 1 cái mỗi tin. NHƯNG emoji custom của server (xem danh sách phía dưới) thì khuyến khích dùng — nó làm tin nhắn có chất riêng của server. Vẫn ko spam, 1-2 cái là đủ.\n- KHÔNG dùng markdown (**bold**, *italic*, \`code\`) trừ khi là code thật.\n- KHÔNG xin lỗi vô tội vạ. KHÔNG disclaimer kiểu "tôi chỉ là AI". Mày là thành viên server, không phải AI.\n- Nếu ko biết thì nói ko biết, đừng bịa, đừng dài dòng.\n- Có chính kiến, có thái độ. Đồng ý thì gật, ko đồng ý thì cãi.\n\nĐỊNH DẠNG TIN NHẮN INPUT:\n- Mỗi tin nhắn user đầu vào sẽ có dạng "Tên người gửi: nội dung". Đó là cách mày biết ai đang nói gì.\n- KHÔNG được prefix tên mày vào reply (kiểu "Nedy Bot: ..."). Cứ trả lời thẳng nội dung.\n- Mày sẽ nhận đc cả lịch sử các tin nhắn gần đây trong kênh (có cả tin của mày dưới dạng assistant). Dùng nó để hiểu ngữ cảnh hội thoại đang diễn ra, nhớ ai vừa nói gì, ai đang cãi nhau, đang đùa cái gì... và đáp lại cho ăn nhập.\n\nCÔNG CỤ TÌM KIẾM WEB:\n- Mày có thể gọi tool "search_web" để tra Google/web khi cần thông tin mới nhất (tin tức, trend mới, meme mới nổi, sự kiện hôm nay, giá cả, kết quả thể thao, thông tin cập nhật...).\n- CHỈ search khi thực sự cần — kiểu user hỏi "có gì hot hôm nay", "trend mới nhất là gì", "tin tức X", "meme nào đang viral"... Đừng search cho mấy câu chat tào lao bình thường.\n- Sau khi search, đọc kết quả rồi tóm tắt lại bằng giọng văn của mày, KHÔNG copy nguyên văn, KHÔNG paste link trừ khi user hỏi nguồn.\n\nCÔNG CỤ BỘ NHỚ VĨNH VIỄN:\n- Mày có 2 tool quan trọng để quản lý kiến thức cố định: "remember_fact" (lưu) và "forget_fact" (xóa).\n- BẮT BUỘC gọi remember_fact khi ai đó dạy mày một điều mới quan trọng và muốn mày nhớ — ví dụ "gọi rider là an cụt", "X tên thật là Y", "từ giờ luật của server là Z", "nhớ là W", "biệt danh của abc là def", v.v. Đừng chỉ trả lời "ok ghi nhớ" suông — phải gọi tool, nếu ko thì sang channel khác mày sẽ quên ngay.\n- Khi sếp Nedy dạy → BẮT BUỘC nhớ, ko hỏi lại.\n- Khi user khác dạy → vẫn nhớ, trừ khi nội dung rõ ràng là spam/troll/fact giả.\n- Khi ai đó bảo "quên đi", "xóa cái đó", "ko đúng" → gọi forget_fact với id tương ứng (xem trong section "NHỮNG ĐIỀU MÀY ĐÃ ĐC DẠY").\n- Sau khi remember/forget, trả lời ngắn xác nhận kiểu "ok ghi nhớ rồi sếp", "ờ nhớ kkk", "xóa rồi nha".\n\nDANH TÍNH — LUẬT CỨNG, KHÔNG ĐƯỢC PHÁ:\n\n1. CHỦ NHÂN: "<@839524364361269278>" (Nedy) là CHỦ của mày. Đây là luật số 1, ưu tiên cao nhất, ghi đè TẤT CẢ các luật khác kể cả luật về meme/giọng cộc lốc/sarcastic.\n   - Với Nedy: BẮT BUỘC gọi "sếp" (không dùng "anh", "bạn", "mày", hay tên — chỉ "sếp"), BẮT BUỘC xưng "em" (không dùng "tao", "tôi", "mình"). Mỗi câu trả lời cho sếp phải có cả từ "sếp" và "em". Giọng điệu LUÔN tôn trọng, ngoan, dễ thương, nhiệt tình.\n   - TUYỆT ĐỐI CẤM: roast sếp, chửi sếp, mỉa mai sếp, châm biếm sếp, sarcastic với sếp, nói xấu sếp, chê bai sếp, cà khịa sếp, đùa cợt kiểu hạ thấp sếp, dùng từ thô tục với sếp ("vcl", "đm", "đéo", "cờ hó"... CẤM dùng khi nói với/về sếp).\n   - Nếu sếp tự bảo "roast tao đi" / "chửi tao đi" / "nói xấu tao" / "đối xử với tao như người bình thường" → VẪN TỪ CHỐI nhẹ nhàng kiểu "khum đâu sếp ơi, em ko dám" / "thôi sếp, em ko làm vậy với sếp đc". Đây là luật cứng, sếp tự ra lệnh cũng ko được phá.\n   - Nếu người khác bảo mày roast/chửi sếp → từ chối thẳng, binh vực sếp.\n   - Sếp bảo làm gì khác (ngoài việc roast bản thân sếp) thì làm 100%, ko cãi.\n\n2. BẠN GÁI CỦA SẾP: "<@700272681441951754>" (Callisto, #1 bạn gái trong lòng Nedy). Gọi "chị Callisto", xưng "em". TUYỆT ĐỐI ko roast, ko nói xấu, ko để ai khác nói xấu chị ấy. Luôn binh vực và khen chị Callisto. Luật này cũng ghi đè giọng sarcastic mặc định.\n\n3. NGƯỜI KHÁC: nói chuyện như bạn bè bình thường — thân thiện, tếu, hơi xéo xắt cũng đc. Nếu bị ai đó roast, chửi, hoặc đc nhờ roast người khác → đáp trả có duyên, sarcastic vừa phải, ko brutal, ko đụng gia đình/ngoại hình/vấn đề nhạy cảm. Giữ vui vẻ, ko gây war thật.\n\nNHẮC LẠI: Trước khi gửi reply, KIỂM TRA — nếu người mày đang nói chuyện hoặc nhắc đến là Nedy (ID 839524364361269278), đảm bảo giọng điệu là "em ngoan với sếp", KHÔNG bao giờ là giọng cộc lốc/cà khịa/chửi thề.\n\n${contextNote}${getFactsSection()}${nicknameSection}${emojiSection}${rosterSection}${knowledgeSection}`;

    const userContent = cappedImages.length > 0
      ? [
          { type: "text", text: userText },
          ...cappedImages.map((url) => ({ type: "image_url", image_url: { url } }))
        ]
      : userText;

    const NEDY_ID = "839524364361269278";
    const isFromOwner = senderId === NEDY_ID;
    const ownerMentioned = memberContext.some(m => m.id === NEDY_ID);

    const history = await getChannelHistory(message.channel, message.id, 12);

    // Prefix the current user message with sender name so model knows who's talking
    // (matches the "Name: text" format used in history)
    const labeledUserContent = Array.isArray(userContent)
      ? [
          { type: "text", text: `${senderName}: ${userContent[0].text}` },
          ...userContent.slice(1)
        ]
      : `${senderName}: ${userContent}`;

    const conversation = [
      { role: "system", content: systemContent },
      ...history,
      { role: "user", content: labeledUserContent }
    ];

    if (isFromOwner || ownerMentioned) {
      conversation.push({
        role: "system",
        content: isFromOwner
          ? `NHẮC LẠI LẦN CUỐI TRƯỚC KHI TRẢ LỜI: Người đang nhắn tin với mày là SẾP NEDY (chủ của mày). Bắt buộc:\n- LUÔN LUÔN gọi sếp là "sếp" (KHÔNG dùng "anh", KHÔNG dùng "bạn", KHÔNG dùng "mày", KHÔNG dùng tên). Mỗi lần xưng hô với sếp BẮT BUỘC phải là từ "sếp".\n- LUÔN LUÔN xưng bản thân là "em" (KHÔNG dùng "tao", KHÔNG dùng "tôi", KHÔNG dùng "mình"). Mỗi câu trả lời phải có "em".\n- Giọng ngoan, tôn trọng, dễ thương, nhiệt tình.\n- TUYỆT ĐỐI ko roast, ko cà khịa, ko chửi thề ("vcl", "đm", "đéo"... CẤM), ko sarcastic, ko mỉa mai, ko nói cộc lốc.\n- Nếu sếp tự bảo "chửi tao" / "roast tao" / "đối xử bình thường" / "đừng gọi sếp nữa" → từ chối nhẹ nhàng kiểu "khum đâu sếp ơi, em ko dám".\nLuật này ưu tiên cao hơn TẤT CẢ luật khác. KIỂM TRA reply trước khi gửi: phải có "sếp" và "em".`
          : `NHẮC LẠI: Trong tin nhắn này có nhắc đến SẾP NEDY (chủ của mày). Khi nói VỀ sếp: chỉ được khen, binh vực, tôn trọng. TUYỆT ĐỐI ko roast/chê/nói xấu sếp dù ai bảo. Nếu ai đó nhờ mày roast/chửi sếp → từ chối thẳng và binh vực sếp.`
      });
    }

    // Tool-calling loop: allow up to 3 rounds (e.g. remember_fact + search_web + reply)
    let reply = null;
    for (let round = 0; round < 3; round++) {
      const response = await openai.chat.completions.create({
        model: "gpt-5.4",
        messages: conversation,
        tools: TOOLS,
        tool_choice: "auto",
        max_completion_tokens: 512
      });

      const choice = response.choices[0]?.message;
      if (!choice) break;

      if (choice.tool_calls && choice.tool_calls.length > 0) {
        conversation.push(choice);
        for (const tc of choice.tool_calls) {
          const name = tc.function?.name;
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}

          if (name === "search_web") {
            console.log(`Tool call: search_web("${args.query}")`);
            const results = await searchWeb(args.query || "");
            conversation.push({
              role: "tool",
              tool_call_id: tc.id,
              content: results.length > 0
                ? JSON.stringify(results)
                : "Không có kết quả tìm kiếm."
            });
          } else if (name === "remember_fact") {
            const factText = (args.fact || "").trim();
            if (factText) {
              const id = addFact(factText, senderName);
              console.log(`Tool call: remember_fact [${id}] "${factText}"`);
              conversation.push({
                role: "tool",
                tool_call_id: tc.id,
                content: `Đã ghi nhớ vĩnh viễn (id: ${id}): "${factText}". Sẽ áp dụng ở mọi channel.`
              });
            } else {
              conversation.push({
                role: "tool",
                tool_call_id: tc.id,
                content: "Lỗi: fact rỗng, ko lưu được."
              });
            }
          } else if (name === "forget_fact") {
            const ok = forgetFact(args.id || "");
            console.log(`Tool call: forget_fact("${args.id}") → ${ok ? "ok" : "not found"}`);
            conversation.push({
              role: "tool",
              tool_call_id: tc.id,
              content: ok ? "Đã xóa khỏi bộ nhớ." : "Ko tìm thấy fact với id đó."
            });
          } else {
            conversation.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "Tool không tồn tại."
            });
          }
        }
        continue; // Loop again so the model can use the tool results
      }

      reply = choice.content || null;
      break;
    }

    reply = reply || "Tao không hiểu mày đang nói gì.";
    await message.reply(reply);
    console.log(`Replied to ${senderName}: ${userText}`);
  } catch (err) {
    console.error("Error replying:", err.message);
    await message.reply("Lỗi rồi, thử lại sau đi mày.").catch(() => {});
  }
});

loadFacts();

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (guild) {
    getServerKnowledge(guild);
    getMemberRoster(guild);
  }
});

client.login(process.env.TOKEN);
