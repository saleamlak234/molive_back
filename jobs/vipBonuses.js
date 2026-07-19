const cron = require("node-cron");
const User = require("../models/User");
const VipBonus = require("../models/VipBonus");
const telegramService = require("../services/telegram");
const { payPendingCredits } = require("../services/commissionService");

// Run VIP bonus job on the 1st of every month at 01:00
cron.schedule("0 1 1 * *", async () => {
  console.log("Running VIP bonus job...");
  await processVipBonuses();
});

async function processVipBonuses() {
  try {
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();

    // Get all VIP users
    const vipUsers = await User.find({ vipLevel: { $gt: 0 } });

    for (const user of vipUsers) {
      // Process VIP monthly bonus
      if (user.vipMonthlyBonus > 0) {
        const existingVipBonus = await VipBonus.findOne({
          user: user._id,
          bonusType: "vip_monthly",
          month: currentMonth,
          year: currentYear,
        });

        if (!existingVipBonus) {
          const vipBonus = new VipBonus({
            user: user._id,
            vipLevel: user.vipLevel,
            bonusType: "vip_monthly",
            amount: user.vipMonthlyBonus,
            month: currentMonth,
            year: currentYear,
            status: "paid",
            description: `VIP Level ${user.vipLevel} Monthly Bonus`,
          });

          await vipBonus.save();

          // Add to user balance
          await User.findByIdAndUpdate(user._id, {
            $inc: { balance: user.vipMonthlyBonus },
          });

          // Pay any pending credits immediately
          await payPendingCredits(user._id);

          // Send notification
          if (user.telegramChatId) {
            await telegramService.sendMessage(
              user.telegramChatId,
              `🏆 VIP Bonus Credited!\n\n` +
                `VIP Level: ${user.vipLevel} (${user.vipBadge.toUpperCase()})\n` +
                `Amount: ${user.vipMonthlyBonus.toLocaleString()} ETB\n` +
                `Your VIP monthly bonus has been added to your balance.`,
            );
          }
        }
      }

      // Team group bonus is now integrated into VIP monthly bonus
    }

    console.log("VIP bonus job completed successfully");
  } catch (error) {
    console.error("VIP bonus job error:", error);
  }
}

// Export for manual testing
module.exports = { processVipBonuses };
