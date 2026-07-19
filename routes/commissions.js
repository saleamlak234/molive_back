const express = require("express");
const Commission = require("../models/Commission");
const User = require("../models/User");

const router = express.Router();

// Get commission statistics
router.get("/stats", async (req, res) => {
  try {
    const userId = req.user._id;

    // Get total commissions (exclude admin upgrade deposit records with level 0)
    const totalCommissions = await Commission.aggregate([
      { $match: { user: userId, level: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    // Get monthly commissions (exclude level 0 records)
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    const monthlyCommissions = await Commission.aggregate([
      {
        $match: {
          user: userId,
          level: { $gt: 0 },
          createdAt: {
            $gte: new Date(currentYear, currentMonth - 1, 1),
            $lt: new Date(currentYear, currentMonth, 1),
          },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    // Get commissions by level (exclude level 0 records)
    const commissionsByLevel = await Commission.aggregate([
      { $match: { user: userId, level: { $gt: 0 } } },
      {
        $group: {
          _id: "$level",
          total: { $sum: "$amount" },
        },
      },
    ]);

    // Get recent commissions (exclude upgrade deposit records)
    const recentCommissions = await Commission.find({
      user: userId,
      level: { $gt: 0 },
      // amount:{$type:'number'}
    })
      .populate("fromUser", "fullName email phoneNumber")
      .sort({ createdAt: -1 })
      .limit(10);

    // Format level commissions
    const levelCommissions = {
      level1Commissions: 0,
      level2Commissions: 0,
      level3Commissions: 0,
      level4Commissions: 0,
    };

    commissionsByLevel.forEach((item) => {
      levelCommissions[`level${item._id}Commissions`] = item.total;
    });

    res.json({
      totalCommissions: totalCommissions[0]?.total || 0,
      monthlyCommissions: monthlyCommissions[0]?.total || 0,
      ...levelCommissions,
      recentCommissions,
    });
  } catch (error) {
    console.error("Get commission stats error:", error);
    res
      .status(500)
      .json({ message: "Server error fetching commission statistics" });
  }
});

// Get commission history
router.get("/", async (req, res) => {
  try {
    const { period = "all" } = req.query;
    const userId = req.user._id;

    let dateFilter = {};
    const now = new Date();

    switch (period) {
      case "today":
        dateFilter = {
          createdAt: {
            $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
            $lt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
          },
        };
        break;
      case "week":
        const weekStart = new Date(now.setDate(now.getDate() - now.getDay()));
        dateFilter = {
          createdAt: {
            $gte: weekStart,
            $lt: new Date(),
          },
        };
        break;
      case "month":
        dateFilter = {
          createdAt: {
            $gte: new Date(now.getFullYear(), now.getMonth(), 1),
            $lt: new Date(now.getFullYear(), now.getMonth() + 1, 1),
          },
        };
        break;
    }

    const commissions = await Commission.find({
      user: userId,
      level: { $gt: 0 },
      ...dateFilter,
    })
      .populate("fromUser", "fullName email phoneNumber")
      .sort({ createdAt: -1 });

    res.json({ commissions });
  } catch (error) {
    console.error("Get commissions error:", error);
    res.status(500).json({ message: "Server error fetching commissions" });
  }
});

module.exports = router;
