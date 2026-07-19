const express = require("express");
const User = require("../models/User");
const Deposit = require("../models/Deposit");
const MerchantAccount = require("../models/MerchantAccount");
const Commission = require("../models/Commission");
const VideoWatch = require("../models/VideoWatch");
const CreditTransfer = require("../models/CreditTransfer");
const Audit = require("../models/Audit");
const Transaction = require("../models/Transaction");
const telegramService = require("../services/telegram");
const commissionService = require("../services/commissionService");
const Notification = require("../models/Notification");

const mongoose = require("mongoose");
const router = express.Router();

// Admin middleware to check permissions
const checkAdminPermission = (requiredRole) => {
  return (req, res, next) => {
    const userRole = req.user.role;

    if (
      requiredRole === "super_admin" &&
      !["super_admin", "admin"].includes(userRole)
    ) {
      return res
        .status(403)
        .json({ message: "Super admin or admin access required" });
    }

    if (
      requiredRole === "transaction_admin" &&
      !["super_admin", "admin", "transaction_admin"].includes(userRole)
    ) {
      return res
        .status(403)
        .json({ message: "Transaction admin access required" });
    }

    if (
      requiredRole === "admin" &&
      !["super_admin", "admin"].includes(userRole)
    ) {
      return res.status(403).json({ message: "Admin access required" });
    }

    next();
  };
};

async function getAdminTotalDeposit(adminId, dateFilter = {}) {
  const [result] = await Deposit.aggregate([
    { $match: { status: "completed", ...dateFilter } },
    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "userDoc",
      },
    },
    { $unwind: "$userDoc" },
    {
      $match: {
        $or: [
          { user: adminId },
          { "userDoc.referredBy": adminId },
          { processedBy: adminId },
        ],
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return result?.total || 0;
}

router.post(
  "/notifications",
  checkAdminPermission("admin"),
  async (req, res) => {
    try {
      const { title, message } = req.body;
      if (!title || !message) {
        return res
          .status(400)
          .json({ message: "Title and message are required" });
      }

      const notification = await Notification.create({
        title: title.trim(),
        message: message.trim(),
        isActive: true,
        createdBy: req.user._id,
      });

      res.json({ notification });
    } catch (error) {
      console.error("Create notification error:", error);
      res.status(500).json({ message: "Server error creating notification" });
    }
  },
);

router.get(
  "/notifications",
  checkAdminPermission("admin"),
  async (req, res) => {
    try {
      const notifications = await Notification.find()
        .sort({ createdAt: -1 })
        .lean();
      res.json({ notifications });
    } catch (error) {
      console.error("Get notifications error:", error);
      res.status(500).json({ message: "Server error fetching notifications" });
    }
  },
);

router.put(
  "/notifications/:id",
  checkAdminPermission("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { title, message, isActive } = req.body;

      if (!title || !message) {
        return res
          .status(400)
          .json({ message: "Title and message are required" });
      }

      const notification = await Notification.findByIdAndUpdate(
        id,
        {
          title: title.trim(),
          message: message.trim(),
          isActive: typeof isActive === "boolean" ? isActive : true,
        },
        { new: true },
      );

      if (!notification) {
        return res.status(404).json({ message: "Notification not found" });
      }

      res.json({ notification });
    } catch (error) {
      console.error("Update notification error:", error);
      res.status(500).json({ message: "Server error updating notification" });
    }
  },
);

router.delete(
  "/notifications/:id",
  checkAdminPermission("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await Notification.findByIdAndDelete(id);

      if (!deleted) {
        return res.status(404).json({ message: "Notification not found" });
      }

      res.json({ message: "Notification deleted successfully" });
    } catch (error) {
      console.error("Delete notification error:", error);
      res.status(500).json({ message: "Server error deleting notification" });
    }
  },
);

// Get admin dashboard statistics
router.get("/stats", checkAdminPermission("admin"), async (req, res) => {
  try {
    // User statistics
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });

    // Admin's Total Deposit = Admin's own deposits + deposits approved by admin for others + upline commissions

    const adminUser = await User.findById(req.user._id);
    const adminBalance = adminUser?.balance || 0;

    // 1. Sum completed initial deposits from admin's direct children
    const directChildrenInitialDepositsResult = await Deposit.aggregate([
      {
        $match: {
          status: "completed",
          package: { $ne: "Credit Payment" },
          upgradedFrom: { $exists: false },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "userDoc",
        },
      },
      { $unwind: "$userDoc" },
      { $match: { "userDoc.referredBy": req.user._id } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const directChildrenInitialDeposits =
      directChildrenInitialDepositsResult[0]?.total || 0;

    // 2. Sum completed credit payment deposits from admin's direct children
    const directChildrenCreditPaymentsResult = await Deposit.aggregate([
      {
        $match: {
          status: "completed",
          package: "Credit Payment",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "userDoc",
        },
      },
      { $unwind: "$userDoc" },
      { $match: { "userDoc.referredBy": req.user._id } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const directChildrenCreditPayments =
      directChildrenCreditPaymentsResult[0]?.total || 0;

    // 3. Sum upgraded deposits approved by this admin
    const upgradedDepositsResult = await Deposit.aggregate([
      {
        $match: {
          status: "completed",
          upgradedFrom: { $exists: true },
          processedBy: req.user._id,
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const upgradedDeposits = upgradedDepositsResult[0]?.total || 0;

    // Admin total deposit: sum of completed deposits where the depositor is
    // the admin's direct child OR the deposit was approved (processedBy) by this admin.
    // This covers initial deposits from direct children, credit payment deposits
    // from direct children, and upgraded deposits approved by the admin.
    const adminTotalAggregate = await Deposit.aggregate([
      { $match: { status: "completed" } },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "userDoc",
        },
      },
      { $unwind: "$userDoc" },
      {
        $match: {
          $or: [
            { "userDoc.referredBy": req.user._id },
            { processedBy: req.user._id },
          ],
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const adminTotalDeposit = adminTotalAggregate[0]?.total || 0;

    // 4. Get admin's upline commissions (commissions from approving deposits)
    const adminCommissionsResult = await Commission.aggregate([
      {
        $match: {
          user: req.user._id,
          type: "deposit", // Only deposit commissions (upline credit)
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const adminCommissions = adminCommissionsResult[0]?.total || 0;

    // video reward admin aggregation removed

    const pendingCreditPayments = await Deposit.countDocuments({
      status: "pending",
      package: "Credit Payment",
    });

    const pendingUpgradedCount = await Deposit.countDocuments({
      status: "pending",
      upgradedFrom: { $exists: true },
      user: { $ne: req.user._id },
    });

    const pendingAdminOwnCount = await Deposit.countDocuments({
      status: "pending",
      user: req.user._id,
    });

    const pendingReferralResult = await Deposit.aggregate([
      { $match: { status: "pending" } },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      { $match: { "user.referredBy": req.user._id } },
      { $count: "count" },
    ]);

    const pendingReferralCount = pendingReferralResult[0]?.count || 0;

    const pendingDeposits =
      pendingUpgradedCount + pendingAdminOwnCount + pendingReferralCount;

    // Recent transactions: admin's own deposits, pending upgrades, direct referral pending deposits and completed deposits approved by admin
    const recentTransactions = await Deposit.find({
      $or: [
        { user: req.user._id, status: "completed" }, // Admin's own completed deposits
        {
          status: "pending",
          upgradedFrom: { $exists: true },
          user: { $ne: req.user._id },
        }, // Pending upgrades from other users
      ],
    })
      .populate("user", "fullName email")
      .populate("merchantAccount", "name")
      .sort({ createdAt: -1 })
      .limit(10);

    // Recent users
    const recentUsers = await User.find()
      .select("-password")
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({
      totalUsers,
      activeUsers,
      totalDeposits: adminTotalDeposit,
      adminTotalDeposit,
      platformTotalDeposit: adminTotalDeposit,
      adminBalance,
      adminCommissions,
      pendingCreditPayments,
      pendingUpgradedDeposits: pendingUpgradedCount,
      pendingAdminOwnDeposits: pendingAdminOwnCount,
      pendingReferralDeposits: pendingReferralCount,
      pendingDeposits,
      recentTransactions,
      recentUsers,
    });
  } catch (error) {
    console.error("Get admin stats error:", error);
    res.status(500).json({ message: "Server error fetching admin statistics" });
  }
});

// Video rewards admin endpoint removed

// Get all users (Super Admin only)
router.get("/users", checkAdminPermission("super_admin"), async (req, res) => {
  try {
    const users = await User.aggregate([
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: "transactions",
          let: { userId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$user", "$$userId"] },
                    { $eq: ["$direction", "credit"] },
                  ],
                },
              },
            },
            { $group: { _id: null, totalPaid: { $sum: "$amount" } } },
          ],
          as: "paidData",
        },
      },
      {
        $addFields: {
          totalPaid: {
            $ifNull: [{ $arrayElemAt: ["$paidData.totalPaid", 0] }, 0],
          },
        },
      },
      { $project: { password: 0, paidData: 0 } },
    ]);

    res.json({ users });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ message: "Server error fetching users" });
  }
});

// Update user status (Super Admin only)
router.put(
  "/users/:userId/status",
  checkAdminPermission("super_admin"),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { isActive } = req.body;

      const user = await User.findByIdAndUpdate(
        userId,
        { isActive },
        { new: true },
      ).select("-password");

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Send notification to user
      if (user.telegramChatId) {
        const message = isActive
          ? "✅ Your account has been activated!"
          : "❌ Your account has been deactivated. Please contact support.";

        await telegramService.sendMessage(user.telegramChatId, message);
      }

      res.json({ message: "User status updated successfully", user });
    } catch (error) {
      console.error("Update user status error:", error);
      res.status(500).json({ message: "Server error updating user status" });
    }
  },
);

// Update user financial information (balance and commissions)
router.put(
  "/users/:userId/financial",
  checkAdminPermission("admin"),
  async (req, res) => {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    try {
      const { userId } = req.params;
      const { fieldChanged, newValue, action, reason } = req.body;

      // Validate inputs
      if (
        !fieldChanged ||
        !["balance", "totalCommissions", "totalDeposits"].includes(fieldChanged)
      ) {
        return res.status(400).json({ message: "Invalid field to update" });
      }
      if (newValue === undefined || newValue === null) {
        return res.status(400).json({ message: "New value is required" });
      }
      if (!action || !["set", "add", "subtract"].includes(action)) {
        return res.status(400).json({ message: "Invalid action type" });
      }
      if (!reason || reason.trim().length === 0) {
        return res
          .status(400)
          .json({ message: "Reason is required for audit trail" });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get old value
      const oldValue = user[fieldChanged] || 0;

      // Calculate new value based on action
      let calculatedNewValue = newValue;
      if (action === "add") {
        calculatedNewValue = Number(oldValue) + Number(newValue);
      } else if (action === "subtract") {
        calculatedNewValue = Number(oldValue) - Number(newValue);
      }

      // Validate that new value is not negative
      if (calculatedNewValue < 0) {
        return res
          .status(400)
          .json({ message: "Resulting value cannot be negative" });
      }

      // Update user
      await User.findByIdAndUpdate(userId, {
        $set: { [fieldChanged]: calculatedNewValue },
      });

      // Create audit log
      await Audit.create({
        adminId: req.user._id,
        userId: userId,
        fieldChanged: fieldChanged,
        oldValue: Number(oldValue),
        newValue: Number(calculatedNewValue),
        action: action,
        reason: reason.trim(),
        description: `Changed ${fieldChanged} from ${oldValue} to ${calculatedNewValue} using ${action} action`,
      });

      // Send notification to user
      const updatedUser = await User.findById(userId);
      if (updatedUser && updatedUser.telegramChatId) {
        await telegramService.sendMessage(
          updatedUser.telegramChatId,
          `📊 Your ${fieldChanged} has been updated by admin.\n` +
            `Old value: ${oldValue.toLocaleString()}\n` +
            `New value: ${calculatedNewValue.toLocaleString()}\n` +
            `Reason: ${reason}`,
        );
      }

      res.json({
        message: "Financial information updated successfully",
        user: updatedUser,
        audit: {
          fieldChanged,
          oldValue,
          newValue: calculatedNewValue,
          action,
        },
      });
    } catch (error) {
      console.error("Update user financial error:", error);
      res
        .status(500)
        .json({ message: "Server error updating user financial information" });
    }
  },
);

// Get audit log for a user
router.get(
  "/users/:userId/audit-log",
  checkAdminPermission("super_admin"),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const auditLog = await Audit.find({ userId })
        .populate("adminId", "fullName email")
        .sort({ createdAt: -1 })
        .limit(20);

      res.json({ auditLog });
    } catch (error) {
      console.error("Get audit log error:", error);
      res.status(500).json({ message: "Server error fetching audit log" });
    }
  },
);

// Get reward history for a specific user (admin access)
router.get(
  "/users/:userId/reward-history",
  checkAdminPermission("transaction_admin"),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const rewards = await Commission.find({
        user: userId,
        type: { $in: ["dailyReturn", "dailyReferral", "directReferral", "deposit"] },
      })
        .populate("fromUser", "fullName")
        .sort({ createdAt: -1 })
        .limit(100);

      res.json({ rewards });
    } catch (error) {
      console.error("Get user reward history error:", error);
      res
        .status(500)
        .json({ message: "Server error fetching user reward history" });
    }
  },
);

// Delete user and all their data (Super Admin only)
router.delete(
  "/users/:userIdOrEmail",
  checkAdminPermission("super_admin"),
  async (req, res) => {
    try {
      const { userIdOrEmail } = req.params;

      let deletedUserInfo = null;
      const affectedAncestors = new Set();

      // Find user by ID or email
      let user = await User.findById(userIdOrEmail);
      if (!user) {
        user = await User.findOne({ email: userIdOrEmail });
      }

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get user's upline (parent)
      const userUpline = user.referredBy || null;

      // Count direct children of the deleted user
      const directChildrenCount = await User.countDocuments({
        referredBy: user._id,
      });

      // If user has an upline, update that parent's directReferrals
      if (userUpline) {
        await User.findByIdAndUpdate(userUpline, {
          $inc: { directReferrals: directChildrenCount - 1 },
        });

        // Walk up ancestors (including parent) and decrement totalTeamSize by 1 (removal of this node)
        let ancestorId = userUpline;
        while (ancestorId) {
          affectedAncestors.add(ancestorId.toString());
          await User.findByIdAndUpdate(ancestorId, {
            $inc: { totalTeamSize: -1 },
          });
          const ancestor = await User.findById(ancestorId).select("referredBy");
          ancestorId = ancestor?.referredBy || null;
        }
      }

      // Reassign all direct children to the deleted user's upline
      await User.updateMany(
        { referredBy: user._id },
        { referredBy: userUpline },
      );

      // Delete all related data
      await Deposit.deleteMany({ user: user._id });
      await Commission.deleteMany({
        $or: [{ user: user._id }, { fromUser: user._id }],
      });
      await VideoWatch.deleteMany({ user: user._id });

      // Delete user
      await User.findByIdAndDelete(user._id);

      deletedUserInfo = {
        id: user._id,
        email: user.email,
        fullName: user.fullName,
      };

      // Update VIP levels for affected ancestors (best-effort)
      for (const ancestorId of Array.from(affectedAncestors)) {
        try {
          const u = await User.findById(ancestorId);
          if (u) await u.updateVipLevel();
        } catch (e) {
          console.error("VIP update failed for ancestor", ancestorId, e);
        }
      }

      res.json({
        message:
          "User and all related data deleted successfully. Downline users reassigned to user's upline.",
        deletedUser: deletedUserInfo,
      });
    } catch (error) {
      console.error("Delete user error:", error);
      if (error.message === "User not found") {
        return res.status(404).json({ message: "User not found" });
      }
      res.status(500).json({ message: "Server error deleting user" });
    }
  },
);

// Get all transactions
router.get(
  "/transactions",
  checkAdminPermission("transaction_admin"),
  async (req, res) => {
    try {
      const [
        adminOwnDeposits,
        pendingUpgradedDeposits,
        pendingReferralDeposits,
        pendingCreditPayments,
        processedByAdminDeposits,
      ] = await Promise.all([
        Deposit.find({ user: req.user._id })
          .populate("user", "fullName email referredBy")
          .populate("merchantAccount", "name type")
          .sort({ createdAt: -1 }),
        Deposit.find({
          status: "pending",
          upgradedFrom: { $exists: true },
          user: { $ne: req.user._id },
        })
          .populate("user", "fullName email referredBy")
          .populate("merchantAccount", "name type")
          .sort({ createdAt: -1 }),
        Deposit.find({ status: "pending" })
          .populate("user", "fullName email referredBy")
          .populate("merchantAccount", "name type")
          .sort({ createdAt: -1 }),
        Deposit.find({
          status: "pending",
          package: "Credit Payment",
        })
          .populate("user", "fullName email referredBy")
          .populate("merchantAccount", "name type")
          .sort({ createdAt: -1 }),
        Deposit.find({
          status: "completed",
          processedBy: req.user._id,
          user: { $ne: req.user._id },
        })
          .populate("user", "fullName email referredBy")
          .populate("merchantAccount", "name type")
          .sort({ createdAt: -1 }),
      ]);

      const referralPendingFiltered = pendingReferralDeposits.filter(
        (deposit) =>
          deposit.user.referredBy &&
          deposit.user.referredBy.toString() === req.user._id.toString(),
      );

      const transactionMap = new Map();
      [
        ...adminOwnDeposits,
        ...pendingUpgradedDeposits,
        ...referralPendingFiltered,
        ...pendingCreditPayments,
        ...processedByAdminDeposits,
      ].forEach((deposit) => {
        transactionMap.set(deposit._id.toString(), deposit);
      });

      const deposits = Array.from(transactionMap.values()).sort(
        (a, b) => b.createdAt - a.createdAt,
      );

      const transactions = deposits.map((d) => ({
        id: d._id,
        type: d.package === "Credit Payment" ? "credit_payment" : "deposit",
        amount: d.amount,
        totalAmount: d.totalAmount,
        package: d.package,
        status: d.status,
        paymentMethod: d.paymentMethod,
        user: d.user,
        merchantAccount: d.merchantAccount,
        receiptUrl: d.receiptUrl,
        transactionReference: d.transactionReference,
        rejectionReason: d.rejectionReason,
        upgradedFrom: d.upgradedFrom,
        upgradedTo: d.upgradedTo,
        canApproveCreditPayment:
          d.package === "Credit Payment" &&
          d.status === "pending" &&
          d.user?.referredBy?.toString() === req.user._id.toString(),
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      }));

      res.json({ transactions });
    } catch (error) {
      console.error("Get transactions error:", error);
      res.status(500).json({ message: "Server error fetching transactions" });
    }
  },
);

// Update transaction status
router.put(
  "/transactions/:transactionId",
  checkAdminPermission("transaction_admin"),
  async (req, res) => {
    try {
      const { transactionId } = req.params;
      const { action, rejectionReason } = req.body;

      const transaction =
        await Deposit.findById(transactionId).populate("user");

      if (!transaction) {
        return res.status(404).json({ message: "Transaction not found" });
      }

      if (transaction.status !== "pending") {
        return res.status(400).json({ message: "Transaction is not pending" });
      }

      if (transaction.package === "Credit Payment") {
        const isDirectReferrer =
          transaction.user.referredBy &&
          transaction.user.referredBy.toString() === req.user._id.toString();

        if (!isDirectReferrer) {
          return res.status(403).json({
            message:
              "Credit payment requests must be approved by the user's direct referrer.",
          });
        }
      }

      // Restrict deposit approval logic
      const newStatus = action === "approve" ? "completed" : "rejected";
      transaction.status = newStatus;
      transaction.processedBy = req.user._id;
      transaction.processedAt = new Date();

      if (action === "reject" && rejectionReason) {
        transaction.rejectionReason = rejectionReason;
      }

      if (action === "approve") {
        if (transaction.upgradedFrom) {
          // Upgrade deposits can be approved by admin
          await transaction.save();
          await commissionService.processDepositApproval(transaction);
        } else if (
          transaction.user._id.toString() === req.user._id.toString()
        ) {
          // Admin can approve their own deposits
          await transaction.save();
          await commissionService.processDepositApproval(transaction);
        } else if (
          transaction.user.referredBy &&
          transaction.user.referredBy.toString() === req.user._id.toString()
        ) {
          // Admin can approve initial deposits from their direct referrals
          await transaction.save();
          await commissionService.processDepositApproval(
            transaction,
            req.user._id,
          );
        } else {
          return res.status(400).json({
            message:
              "Initial deposits must be approved by the user's direct referrer or the user themselves if they are an admin.",
          });
        }
      } else {
        // For rejected deposits, just save
        await transaction.save();
      }

      // Send notification to user
      if (transaction.user.telegramChatId) {
        const message =
          action === "approve"
            ? `✅ Your deposit of ${transaction.amount.toLocaleString()} ETB has been approved!`
            : `❌ Your deposit has been rejected. Reason: ${rejectionReason || "Not specified"}`;

        await telegramService.sendMessage(
          transaction.user.telegramChatId,
          message,
        );
      }

      res.json({ message: "Transaction updated successfully", transaction });
    } catch (error) {
      console.error("Update transaction error:", error);
      res.status(500).json({ message: "Server error updating transaction" });
    }
  },
);

// Merchant Account Management (Super Admin only)
router.get(
  "/merchant-accounts",
  checkAdminPermission("super_admin"),
  async (req, res) => {
    try {
      const merchantAccounts = await MerchantAccount.find().sort({
        createdAt: -1,
      });
      res.json({ merchantAccounts });
    } catch (error) {
      console.error("Get merchant accounts error:", error);
      res
        .status(500)
        .json({ message: "Server error fetching merchant accounts" });
    }
  },
);

router.post(
  "/merchant-accounts",
  checkAdminPermission("super_admin"),
  async (req, res) => {
    try {
      const merchantAccount = new MerchantAccount(req.body);
      await merchantAccount.save();
      res.status(201).json({
        message: "Merchant account created successfully",
        merchantAccount,
      });
    } catch (error) {
      console.error("Create merchant account error:", error);
      res
        .status(500)
        .json({ message: "Server error creating merchant account" });
    }
  },
);

router.put(
  "/merchant-accounts/:id",
  checkAdminPermission("super_admin"),
  async (req, res) => {
    try {
      const merchantAccount = await MerchantAccount.findById(req.params.id);
      if (!merchantAccount) {
        return res.status(404).json({ message: "Merchant account not found" });
      }

      const mergedData = {
        ...merchantAccount.toObject(),
        ...req.body,
      };

      merchantAccount.set({
        ...req.body,
        bankName: mergedData.type === "bank" ? mergedData.bankName : undefined,
        phoneNumber:
          mergedData.type === "mobile_money"
            ? mergedData.phoneNumber
            : undefined,
      });
      await merchantAccount.save();

      res.json({
        message: "Merchant account updated successfully",
        merchantAccount,
      });
    } catch (error) {
      console.error("Update merchant account error:", error);
      res
        .status(500)
        .json({ message: "Server error updating merchant account" });
    }
  },
);

async function processDepositApproval(deposit) {
  try {
    // Update user's total deposits and mark as having made a deposit
    await User.findByIdAndUpdate(deposit.user._id, {
      $inc: { totalDeposits: deposit.amount },
      hasMadeDeposit: true,
      $unset: { registrationReward: "" },
    });

    // Process commissions
    await processDepositCommissions(deposit);
  } catch (error) {
    console.error("Process deposit approval error:", error);
  }
}

async function getPlatformAdmin() {
  let adminUser = await User.findOne({ role: "super_admin" });
  if (!adminUser) adminUser = await User.findOne({ role: "transaction_admin" });
  if (!adminUser) adminUser = await User.findOne({ role: "admin" });
  return adminUser;
}

// Process commission for approved deposit
async function processDepositCommissions(deposit) {
  try {
    const packagePrices = {
      "8th Stock Package": 320000,
      "7th Stock Package": 160000,
      "6th Stock Package": 80000,
      "5th Stock Package": 40000,
      "4th Stock Package": 20000,
      "3rd Stock Package": 10000,
      "2nd Stock Package": 5000,
      "1st Stock Package": 2500,
    };

    const getPackagePrice = (depositItem) => {
      if (depositItem.totalAmount && depositItem.totalAmount > 0) {
        return depositItem.totalAmount;
      }
      if (depositItem.package && packagePrices[depositItem.package]) {
        return packagePrices[depositItem.package];
      }
      return depositItem.amount || 0;
    };

    const user = await User.findById(deposit.user).populate("referredBy");
    if (!user) return;

    const adminUser = await getPlatformAdmin();

    // Upgrade deposits: admin-only distribution, no parent/upline commission
    if (deposit.upgradedFrom) {
      if (!adminUser) return;

      const commissionAmount = deposit.totalAmount;
      const commission = new Commission({
        user: adminUser._id,
        fromUser: deposit.user,
        // amount: commissionAmount,
        level: 0,
        type: "deposit",
        description: `Admin deposit record for upgrade deposit from ${user.fullName}`,
        sourceTransaction: deposit._id,
        sourceModel: "Deposit",
      });

      await commission.save();
      await User.findByIdAndUpdate(adminUser._id, {
        $inc: {
          // balance: commissionAmount,
          totalDeposits: commissionAmount,
        },
      });

      if (adminUser.telegramChatId) {
        await telegramService.sendMessage(
          adminUser.telegramChatId,
          `💰 Upgrade deposit approved. Admin recorded ${commissionAmount.toLocaleString()} ETB from ${user.fullName}.`,
        );
      }
      return;
    }

    // Initial deposits: distribute commissions to referral chain for up to 3 upline levels
    if (user.referredBy) {
      let currentUser = user;
      const packagePrice = getPackagePrice(deposit);
      const commissionRates = [0.08, 0.06, 0.04]; // 8%, 6%, 4%
      let level = 1;

      while (
        currentUser &&
        currentUser.referredBy &&
        level <= commissionRates.length
      ) {
        const referrerId = currentUser.referredBy._id || currentUser.referredBy;
        const referrer = await User.findById(referrerId);
        if (!referrer) break;

        const commissionAmount = packagePrice * commissionRates[level - 1];
        if (commissionAmount <= 0) break;

        const commission = new Commission({
          user: referrer._id,
          fromUser: deposit.user._id,
          amount: commissionAmount,
          level,
          type: "deposit",
          description: `Level ${level} commission from ${user.fullName}'s deposit`,
          sourceTransaction: deposit._id,
          sourceModel: "Deposit",
        });

        await commission.save();
        await User.findByIdAndUpdate(referrer._id, {
          $inc: {
            balance: commissionAmount,
            totalCommissions: commissionAmount,
          },
        });

        if (referrer.telegramChatId) {
          await telegramService.sendMessage(
            referrer.telegramChatId,
            `💰 Commission earned!\n` +
              `Amount: ${commissionAmount.toLocaleString()} ETB\n` +
              `From ${user.fullName}'s deposit (level ${level})`,
          );
        }

        currentUser = referrer;
        level++;
      }
    }
  } catch (error) {
    console.error("Commission processing error:", error);
  }
}

// Get transaction summary by period
router.get(
  "/transaction-summary",
  checkAdminPermission("admin"),
  async (req, res) => {
    try {
      const { period = "all" } = req.query;
      let dateFilter = {};
      const now = new Date();

      switch (period) {
        case "today":
          dateFilter = {
            createdAt: {
              $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
              $lt: new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate() + 1,
              ),
            },
          };
          break;
        case "week":
          const weekStart = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() - now.getDay(),
          );
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

      // Platform total deposits (all completed deposits)
      const [platformDepositResult] = await Deposit.aggregate([
        { $match: { status: "completed", ...dateFilter } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);

      const platformTotalDeposit = platformDepositResult
        ? platformDepositResult.total
        : 0;

      const totalDeposit = await getAdminTotalDeposit(req.user._id, dateFilter);

      res.json({ totalDeposit, platformTotalDeposit });
    } catch (error) {
      console.error("Get transaction summary error:", error);
      res
        .status(500)
        .json({ message: "Server error fetching transaction summary" });
    }
  },
);

// Credit Transfer Approval Routes (Any authenticated user can access)
router.get("/credit-transfers/pending", async (req, res) => {
  try {
    let query = { approvalStatus: "pending" };

    // If not admin, only show transfers sent TO this user
    const userRole = req.user.role;
    const isAdmin = ["admin", "super_admin", "transaction_admin"].includes(
      userRole,
    );

    if (!isAdmin) {
      query.toUser = req.user._id;
    }

    const pendingTransfers = await CreditTransfer.find(query)
      .populate("fromUser", "fullName username")
      .populate("toUser", "fullName username role")
      .sort({ createdAt: -1 });

    res.json({ transfers: pendingTransfers });
  } catch (error) {
    console.error("Get pending credit transfers error:", error);
    res
      .status(500)
      .json({ message: "Server error fetching pending transfers" });
  }
});

router.post("/credit-transfers/:id/approve", async (req, res) => {
  try {
    const transfer = await commissionService.approveCreditTransfer(
      req.params.id,
      req.user._id,
    );

    res.json({
      message: "Credit transfer approved successfully",
      transfer,
    });
  } catch (error) {
    console.error("Approve credit transfer error:", error);
    res
      .status(500)
      .json({ message: error.message || "Server error approving transfer" });
  }
});

router.post("/credit-transfers/:id/reject", async (req, res) => {
  try {
    const { reason } = req.body;
    const transfer = await commissionService.rejectCreditTransfer(
      req.params.id,
      req.user._id,
      reason,
    );

    res.json({
      message: "Credit transfer rejected successfully",
      transfer,
    });
  } catch (error) {
    console.error("Reject credit transfer error:", error);
    res
      .status(500)
      .json({ message: error.message || "Server error rejecting transfer" });
  }
});

router.get("/credit-transfers/history", async (req, res) => {
  try {
    let query = {
      approvalStatus: { $in: ["approved", "rejected"] },
    };

    // If not admin, only show transfers involving this user
    const userRole = req.user.role;
    const isAdmin = ["admin", "super_admin", "transaction_admin"].includes(
      userRole,
    );

    if (!isAdmin) {
      query.$or = [
        { fromUser: req.user._id },
        { toUser: req.user._id },
        { approvedBy: req.user._id },
      ];
    }

    const transfers = await CreditTransfer.find(query)
      .populate("fromUser", "fullName username")
      .populate("toUser", "fullName username role")
      .populate("approvedBy", "fullName username")
      .sort({ approvedAt: -1 })
      .limit(100);

    res.json({ transfers });
  } catch (error) {
    console.error("Get credit transfer history error:", error);
    res.status(500).json({ message: "Server error fetching transfer history" });
  }
});

module.exports = router;
