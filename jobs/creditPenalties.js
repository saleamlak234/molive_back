const cron = require("node-cron");
const User = require("../models/User");
const CreditTransfer = require("../models/CreditTransfer");
const telegramService = require("../services/telegram");

console.log("creditPenalties job loaded and scheduled to run daily at 01:00");

cron.schedule("0 1 * * *", async () => {
  try {
    const now = new Date();
    const overdueTransfers = await CreditTransfer.aggregate([
      {
        $match: {
          status: "pending",
          dueAt: { $lt: now },
        },
      },
      {
        $group: {
          _id: "$fromUser",
          totalDue: { $sum: "$amount" },
        },
      },
    ]);

    for (const transfer of overdueTransfers) {
      const userId = transfer._id;
      const totalDue = transfer.totalDue;

      // Since payments are now immediate, only notify users about overdue credits
      // but don't block them automatically
      const user = await User.findById(userId);
      if (user && user.telegramChatId) {
        await telegramService.sendMessage(
          user.telegramChatId,
          `⚠️ You have overdue upline credit of ${totalDue.toLocaleString()} ETB.\n` +
            `Please ensure you have sufficient balance to pay when earnings are credited.`,
        );
      }
    }
  } catch (error) {
    console.error("Credit penalties job error:", error);
  }
});
