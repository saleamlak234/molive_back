const express = require("express");
const User = require("../models/User");
const VipBonus = require("../models/VipBonus");

const router = express.Router();

// Get VIP statistics
router.get("/stats", async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);

    // Get VIP bonus history
    const vipBonuses = await VipBonus.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(10);

    // Calculate total VIP earnings
    const totalVipEarnings = await VipBonus.aggregate([
      { $match: { user: userId, status: "paid" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    // Get monthly VIP earnings
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    const monthlyVipEarnings = await VipBonus.aggregate([
      {
        $match: {
          user: userId,
          status: "paid",
          month: currentMonth,
          year: currentYear,
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    res.json({
      vipLevel: user.vipLevel,
      vipBadge: user.vipBadge,
      vipMonthlyBonus: user.vipMonthlyBonus,
      directReferrals: user.directReferrals,
      totalTeamSize: user.totalTeamSize,
      totalVipEarnings: totalVipEarnings[0]?.total || 0,
      monthlyVipEarnings: monthlyVipEarnings[0]?.total || 0,
      vipBonuses,
      nextLevelRequirement: getNextLevelRequirement(
        user.vipLevel,
        user.directReferrals,
        user.totalTeamSize,
      ),
    });
  } catch (error) {
    console.error("Get VIP stats error:", error);
    res.status(500).json({ message: "Server error fetching VIP statistics" });
  }
});

// Get VIP leaderboard
router.get("/leaderboard", async (req, res) => {
  try {
    const topVipUsers = await User.find({ vipLevel: { $gt: 0 } })
      .select(
        "fullName vipLevel vipBadge directReferrals totalTeamSize vipMonthlyBonus",
      )
      .sort({ vipLevel: -1, directReferrals: -1 })
      .limit(50);

    res.json({ leaderboard: topVipUsers });
  } catch (error) {
    console.error("Get VIP leaderboard error:", error);
    res.status(500).json({ message: "Server error fetching VIP leaderboard" });
  }
});

// Helper function to get next level requirement
function getNextLevelRequirement(
  currentLevel,
  currentReferrals,
  currentTeamSize,
) {
  const requirements = {
    // Level mapping based on your numbers:
    // 13 direct => 10,000
    // 20 direct => 17,000
    // 30 direct => 25,000
    // 40 direct => 35,000
    // 40 direct + team 500 => 80,000
    // 40 direct + team 1000 => 150,000
    0: { level: 1, referrals: 13, team: 0, badge: "bronze", bonus: 10000 },
    1: { level: 2, referrals: 20, team: 0, badge: "silver", bonus: 17000 },
    2: { level: 3, referrals: 30, team: 0, badge: "gold", bonus: 25000 },
    3: { level: 4, referrals: 40, team: 0, badge: "platinum", bonus: 35000 },
    4: { level: 5, referrals: 40, team: 500, badge: "diamond", bonus: 80000 },
    5: { level: 6, referrals: 40, team: 1000, badge: "master", bonus: 150000 },
    6: null,
  };

  const nextLevel = requirements[currentLevel];
  if (!nextLevel) return null;

  const remainingReferrals = Math.max(
    0,
    nextLevel.referrals - currentReferrals,
  );
  const remainingTeam = Math.max(0, nextLevel.team - currentTeamSize);

  return {
    ...nextLevel,
    remainingReferrals,
    remainingTeam,
  };
}

module.exports = router;
