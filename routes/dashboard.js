const express = require("express");
const User = require("../models/User");
const Deposit = require("../models/Deposit");
const Commission = require("../models/Commission");
const router = express.Router();

const TIME_ZONE = "Africa/Nairobi";

const getTimeZoneOffsetMs = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const partMap = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  const localTimeUtc = Date.UTC(
    Number(partMap.year),
    Number(partMap.month) - 1,
    Number(partMap.day),
    Number(partMap.hour),
    Number(partMap.minute),
    Number(partMap.second),
  );

  const actualUtc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  );

  return localTimeUtc - actualUtc;
};

const getTodayRangeServer = () => {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const offsetMs = getTimeZoneOffsetMs(now, TIME_ZONE);

  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMs);
  const end = new Date(
    Date.UTC(year, month - 1, day, 23, 59, 59, 999) - offsetMs,
  );
  return { start, end };
};

const REFERRAL_REWARD_TIERS = [
  { threshold: 10, amount: 2499 },
  { threshold: 5, amount: 999 },
  { threshold: 4, amount: 499 },
  { threshold: 3, amount: 199 },
  { threshold: 2, amount: 99 },
  { threshold: 1, amount: 49 },
];

function getDailyReferralRewardAmount(count) {
  for (const tier of REFERRAL_REWARD_TIERS) {
    if (count >= tier.threshold) {
      return tier.amount;
    }
  }
  return 0;
}

// Get dashboard statibstics
router.get("/stats", async (req, res) => {
  try {
    const userId = req.user._id;

    // Get user's current data
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Get monthly earnings (current month)
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    const monthlyEarnings = await Commission.aggregate([
      {
        $match: {
          user: userId,
          createdAt: {
            $gte: new Date(currentYear, currentMonth - 1, 1),
            $lt: new Date(currentYear, currentMonth, 1),
          },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    // Get today's direct referral count and daily reward amount
    const { start: startOfDay, end: endOfDay } = getTodayRangeServer();

    const directReferralUsers = await User.find({
      referredBy: userId,
    })
      .select("_id")
      .lean();

    const directReferralIds = directReferralUsers.map((ref) => ref._id);
    const todaysDirectReferrals = await Deposit.countDocuments({
      user: { $in: directReferralIds },
      status: "completed",
      upgradedFrom: null,
      package: { $ne: "Credit Payment" },
      completedAt: { $gte: startOfDay, $lte: endOfDay },
    });

    const todaysDirectReferralReward = await Commission.aggregate([
      {
        $match: {
          user: userId,
          type: "directReferral",
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const dailyReferralReward = await Commission.aggregate([
      {
        $match: {
          user: userId,
          type: "dailyReferral",
        },
      },
      {
        $lookup: {
          from: "deposits",
          let: { sourceTransaction: "$sourceTransaction" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$_id", "$$sourceTransaction"] },
              },
            },
            { $project: { completedAt: 1, _id: 1 } },
          ],
          as: "sourceDeposit",
        },
      },
      {
        $addFields: {
          sourceDeposit: { $arrayElemAt: ["$sourceDeposit", 0] },
        },
      },
      {
        $match: {
          $or: [
            {
              $and: [
                { sourceDeposit: { $ne: null } },
                {
                  "sourceDeposit.completedAt": {
                    $gte: startOfDay,
                    $lte: endOfDay,
                  },
                },
              ],
            },
            {
              $and: [
                {
                  $or: [
                    { sourceDeposit: null },
                    { sourceDeposit: { $exists: false } },
                  ],
                },
                { createdAt: { $gte: startOfDay, $lte: endOfDay } },
              ],
            },
          ],
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const firstSelfVideoReward = await Commission.findOne({
      user: userId,
      type: "dailyReturn",
    }).sort({ createdAt: 1 });

    const selfVideoRewardStartingPoint =
      firstSelfVideoReward?.createdAt || new Date(0);

    const commissionBaseTotal = await Commission.aggregate([
      {
        $match: {
          user: userId,
          type: { $ne: "dailyReturn" },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const selfVideoRewardTotal = await Commission.aggregate([
      {
        $match: {
          user: userId,
          type: "dailyReturn",
          createdAt: { $gte: selfVideoRewardStartingPoint },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const totalPaidBalance =
      Number(commissionBaseTotal[0]?.total || 0) +
      Number(selfVideoRewardTotal[0]?.total || 0);

    // Get recent transactions (deposits and commissions)
    const recentDeposits = await Deposit.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const recentCommissions = await Commission.find({ user: userId })
      .populate("createdByAdmin", "fullName")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // Combine and format transactions
    const allTransactions = [
      ...recentDeposits.map((d) => ({
        id: d._id,
        type: "deposit",
        amount: d.amount,
        status: d.status,
        createdAt: d.createdAt,
        description: `Deposit - ${d.package}`,
      })),
      ...recentCommissions.map((c) => ({
        id: c._id,
        type: "commission",
        amount: c.amount,
        status: "completed",
        createdAt: c.createdAt,
        description: c.description,
        failureReason: c.failureReason || null,
        isManual: c.isManual || false,
        adminName: c.createdByAdmin?.fullName || null,
      })),
    ];

    // Sort by date and take latest 10
    const recentTransactions = allTransactions
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10);

    res.json({
      totalBalance: user.balance,
      totalDeposits: user.totalDeposits,
      totalCommissions: commissionBaseTotal[0]?.total || 0,
      totalPaidBalance,
      pendingUplineCredit: user.pendingUplineCredit,
      creditBlocked: user.creditBlocked,
      monthlyEarnings: monthlyEarnings[0]?.total || 0,
      directReferrals: user.directReferrals,
      totalTeamSize: user.totalTeamSize,
      todaysDirectReferrals,
      todaysDirectReferralReward: todaysDirectReferralReward[0]?.total || 0,
      dailyReferralReward: dailyReferralReward[0]?.total || 0,
      recentTransactions,
    });
  } catch (error) {
    console.error("Get dashboard stats error:", error);
    res
      .status(500)
      .json({ message: "Server error fetching dashboard statistics" });
  }
});

router.post("/claim-direct-referral-reward", async (req, res) => {
  try {
    const userId = req.user._id;
    const { start: startOfDay, end: endOfDay } = getTodayRangeServer();

    const directReferralUsers = await User.find({ referredBy: userId })
      .select("_id")
      .lean();

    if (!directReferralUsers.length) {
      return res
        .status(400)
        .json({ message: "No direct referrals available to claim a reward." });
    }

    const directReferralIds = directReferralUsers.map((ref) => ref._id);
    const directReferralCount = await Deposit.countDocuments({
      user: { $in: directReferralIds },
      status: "completed",
      upgradedFrom: null,
      package: { $ne: "Credit Payment" },
      completedAt: { $gte: startOfDay, $lte: endOfDay },
    });

    if (directReferralCount <= 0) {
      return res.status(400).json({
        message: "No eligible direct referral reward available for today.",
      });
    }

    const existingDirectReferralCommissions = await Commission.find({
      user: userId,
      type: "directReferral",
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    })
      .select("amount")
      .lean();

    const highestClaimedTier = existingDirectReferralCommissions.reduce(
      (max, commission) => Math.max(max, commission.amount),
      0,
    );

    const currentTierAmount = getDailyReferralRewardAmount(directReferralCount);

    if (currentTierAmount <= highestClaimedTier) {
      return res.status(409).json({
        message:
          "You have already claimed the current referral tier reward. Wait for a new referral.",
      });
    }

    await User.findByIdAndUpdate(userId, {
      $inc: { balance: currentTierAmount, totalCommissions: currentTierAmount },
    });

    const commission = await Commission.create({
      user: userId,
      amount: currentTierAmount,
      level: 0,
      type: "directReferral",
      description: `Spin wheel referral reward for ${directReferralCount} direct referral(s) today`,
    });

    res.json({
      message: "Referral reward claimed successfully.",
      amount: currentTierAmount,
      commissionId: commission._id,
    });
  } catch (error) {
    console.error("Claim direct referral reward error:", error);
    res.status(500).json({ message: "Server error claiming referral reward" });
  }
});

module.exports = router;
