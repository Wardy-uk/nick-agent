(async () => {
  const ms = require("./services/microsoft");
  const ep = require("./services/email-priority");
  const emails = await ms.fetchRecentEmails(24, 40) || [];
  const out = emails.slice(0, 15).map((e) => ({
    subject: e.subject,
    from: e.from,
    fromEmail: e.fromEmail,
    isRead: e.isRead,
    importance: e.importance,
    preview: (e.preview || "").slice(0, 120),
    eval: ep.evaluateEmail(e)
  }));
  console.log(JSON.stringify({ count: emails.length, out }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
