const express = require("express");
const Transaction = require("../models/Transaction");

const router = express.Router();

router.get("/history", async (req, res) => {
  try {
    const userId = req.user._id;
    const { period = "all" } = req.query;
    const now = new Date();
    let filter = { user: userId };

    // Support both old naming (today, week, month) and new naming (daily, weekly, monthly)
    if (period === "daily" || period === "today") {
      filter.createdAt = {
        $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        $lt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
      };
    } else if (period === "weekly" || period === "week") {
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - 6);
      weekStart.setHours(0, 0, 0, 0);
      filter.createdAt = { $gte: weekStart, $lt: now };
    } else if (period === "monthly" || period === "month") {
      const monthStart = new Date(now);
      monthStart.setDate(now.getDate() - 29);
      monthStart.setHours(0, 0, 0, 0);
      filter.createdAt = { $gte: monthStart, $lt: now };
    }

    const transactions = await Transaction.find(filter)
      .populate("relatedUser", "fullName email")
      .sort({ createdAt: -1 })
      .limit(200);

    res.json({ transactions });
  } catch (error) {
    console.error("Get transaction history error:", error);
    res.status(500).json({ message: "Error fetching transaction history" });
  }
});

module.exports = router;
