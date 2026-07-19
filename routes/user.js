const express = require("express");
const User = require("../models/User");
const Deposit = require("../models/Deposit");
const Commission = require("../models/Commission");
const MerchantAccount = require("../models/MerchantAccount");
const telegramService = require("../services/telegram");
const commissionService = require("../services/commissionService");

const router = express.Router();

// Update user profile
router.put("/profile", async (req, res) => {
  try {
    const { fullName, phoneNumber } = req.body;
    const userId = req.user._id;

    const user = await User.findByIdAndUpdate(
      userId,
      { fullName, phoneNumber },
      { new: true },
    ).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      message: "Profile updated successfully",
      user,
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ message: "Server error updating profile" });
  }
});

// Link Telegram account
router.post("/link-telegram", async (req, res) => {
  try {
    const { telegramChatId } = req.body;
    const userId = req.user._id;

    const user = await User.findByIdAndUpdate(
      userId,
      { telegramChatId },
      { new: true },
    ).select("-password");

    res.json({
      message: "Telegram account linked successfully",
      user,
    });
  } catch (error) {
    console.error("Link Telegram error:", error);
    res.status(500).json({ message: "Server error linking Telegram account" });
  }
});

// Get user's merchant accounts
router.get("/merchant-accounts", async (req, res) => {
  try {
    const userId = req.user._id;
    const merchantAccounts = await MerchantAccount.find({
      user: userId,
      isActive: true,
    });
    res.json({ merchantAccounts });
  } catch (error) {
    console.error("Get merchant accounts error:", error);
    res
      .status(500)
      .json({ message: "Server error fetching merchant accounts" });
  }
});

// Add merchant account
router.post("/merchant-accounts", async (req, res) => {
  try {
    const userId = req.user._id;

    const {
      name,
      type,
      accountNumber,
      accountName,
      bankName,
      phoneNumber,
      instructions,
    } = req.body;

    if (!name?.trim()) {
      return res
        .status(400)
        .json({ message: "Merchant account name is required." });
    }
    if (!["bank", "mobile_money"].includes(type)) {
      return res
        .status(400)
        .json({ message: "Invalid merchant account type." });
    }
    if (type === "bank") {
      if (!accountNumber?.trim()) {
        return res.status(400).json({
          message:
            "Bank account number is required for bank merchant accounts.",
        });
      }
      if (!bankName?.trim()) {
        return res.status(400).json({
          message: "Bank name is required for bank merchant accounts.",
        });
      }
    } else if (type === "mobile_money") {
      if (!phoneNumber?.trim()) {
        return res.status(400).json({
          message:
            "Phone number is required for mobile money merchant accounts.",
        });
      }
    }

    const account = new MerchantAccount({
      user: userId,
      name: name.trim(),
      type,
      accountNumber: type === "bank" ? accountNumber?.trim() : undefined,
      accountName: accountName?.trim() || "",
      bankName: type === "bank" ? bankName?.trim() : undefined,
      phoneNumber: type === "mobile_money" ? phoneNumber?.trim() : undefined,
      instructions: instructions || "",
    });

    await account.save();
    res
      .status(201)
      .json({ message: "Merchant account added successfully", account });
  } catch (error) {
    console.error("Add merchant account error:", error);
    res.status(500).json({ message: "Server error adding merchant account" });
  }
});

// Update merchant account
router.put("/merchant-accounts/:id", async (req, res) => {
  try {
    const userId = req.user._id;
    const { id } = req.params;

    const account = await MerchantAccount.findOne({ _id: id, user: userId });
    if (!account) {
      return res.status(404).json({ message: "Merchant account not found" });
    }

    const mergedData = {
      ...account.toObject(),
      ...req.body,
    };

    if (!mergedData.name?.trim()) {
      return res
        .status(400)
        .json({ message: "Merchant account name is required." });
    }
    if (!["bank", "mobile_money"].includes(mergedData.type)) {
      return res
        .status(400)
        .json({ message: "Invalid merchant account type." });
    }
    if (mergedData.type === "bank") {
      if (!mergedData.accountNumber?.trim()) {
        return res.status(400).json({
          message:
            "Bank account number is required for bank merchant accounts.",
        });
      }
      if (!mergedData.bankName?.trim()) {
        return res.status(400).json({
          message: "Bank name is required for bank merchant accounts.",
        });
      }
    } else if (mergedData.type === "mobile_money") {
      if (!mergedData.phoneNumber?.trim()) {
        return res.status(400).json({
          message:
            "Phone number is required for mobile money merchant accounts.",
        });
      }
    }

    account.set({
      name: mergedData.name.trim(),
      type: mergedData.type,
      accountNumber:
        mergedData.type === "bank"
          ? mergedData.accountNumber?.trim()
          : undefined,
      accountName: mergedData.accountName?.trim() || "",
      bankName:
        mergedData.type === "bank" ? mergedData.bankName?.trim() : undefined,
      phoneNumber:
        mergedData.type === "mobile_money"
          ? mergedData.phoneNumber?.trim()
          : undefined,
      instructions: mergedData.instructions || "",
    });
    await account.save();
    res.json({ message: "Merchant account updated successfully", account });
  } catch (error) {
    console.error("Update merchant account error:", error);
    res.status(500).json({ message: "Server error updating merchant account" });
  }
});

// Delete merchant account
router.delete("/merchant-accounts/:id", async (req, res) => {
  try {
    const userId = req.user._id;
    const { id } = req.params;

    const account = await MerchantAccount.findOneAndUpdate(
      { _id: id, user: userId },
      { isActive: false },
      { new: true },
    );

    if (!account) {
      return res.status(404).json({ message: "Merchant account not found" });
    }

    res.json({ message: "Merchant account deleted successfully" });
  } catch (error) {
    console.error("Delete merchant account error:", error);
    res.status(500).json({ message: "Server error deleting merchant account" });
  }
});

// Get pending referral deposits and credit requests from direct referrals
router.get("/referral-deposits", async (req, res) => {
  try {
    const userId = req.user._id;

    // Find all direct referrals
    const referrals = await User.find({ referredBy: userId }).select("_id");

    if (referrals.length === 0) {
      return res.json({ deposits: [] });
    }

    const referralIds = referrals.map((r) => r._id);

    // Get pending referral deposits / credit payment requests (not upgrades)
    const deposits = await Deposit.find({
      user: { $in: referralIds },
      status: "pending",
      upgradedFrom: null,
    })
      .populate("user", "fullName level")
      .populate("merchantAccount")
      .sort({ createdAt: -1 });

    res.json({ deposits, count: deposits.length });
  } catch (error) {
    console.error("Get referral deposits error:", error);
    res
      .status(500)
      .json({ message: "Server error fetching referral deposits" });
  }
});

// Get referral deposit approval history for direct referrals
router.get("/referral-deposits/history", async (req, res) => {
  try {
    const userId = req.user._id;
    const referrals = await User.find({ referredBy: userId }).select("_id");

    if (referrals.length === 0) {
      return res.json({ deposits: [] });
    }

    const referralIds = referrals.map((r) => r._id);

    const historyDeposits = await Deposit.find({
      user: { $in: referralIds },
      status: { $in: ["completed", "rejected"] },
      upgradedFrom: null,
    })
      .populate("user", "fullName level")
      .populate("merchantAccount")
      .populate("processedBy", "fullName")
      .sort({ processedAt: -1, createdAt: -1 });

    res.json({ deposits: historyDeposits, count: historyDeposits.length });
  } catch (error) {
    console.error("Get referral deposit history error:", error);
    res
      .status(500)
      .json({ message: "Server error fetching referral deposit history" });
  }
});

// Approve or reject referral deposit or credit payment request
router.post("/referral-deposits/:depositId", async (req, res) => {
  try {
    const { depositId } = req.params;
    const { action, rejectionReason } = req.body; // action: 'approve' or 'reject'
    const userId = req.user._id;

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ message: "Invalid action" });
    }

    // Find the deposit
    const deposit = await Deposit.findById(depositId).populate("user");
    if (!deposit) {
      return res.status(404).json({ message: "Deposit not found" });
    }

    if (deposit.status !== "pending" || deposit.upgradedFrom) {
      return res.status(400).json({
        message: "This request is not pending or cannot be approved.",
      });
    }

    // Check if the deposit is from a direct referral
    if (deposit.user.referredBy.toString() !== userId.toString()) {
      return res.status(403).json({
        message: "You can only approve requests from your direct referrals.",
      });
    }

    const approver = await User.findById(userId);
    if (approver.creditBlocked || approver.pendingUplineCredit > 0) {
      return res.status(403).json({
        message:
          "You cannot approve child deposits while you have unpaid upline credit.",
      });
    }

    // Update deposit
    deposit.status = action === "approve" ? "completed" : "rejected";
    deposit.processedBy = userId;
    deposit.processedAt = new Date();
    if (action === "reject" && rejectionReason) {
      deposit.rejectionReason = rejectionReason;
    }
    deposit.completedAt = action === "approve" ? new Date() : null;
    await deposit.save();

    if (action === "approve") {
      await commissionService.processDepositApproval(deposit, userId);
    }

    // Send notification to the child
    if (deposit.user.telegramChatId) {
      const message =
        action === "approve"
          ? deposit.package === "Credit Payment"
            ? `✅ Your credit payment request has been approved by your referrer!`
            : `✅ Your initial deposit has been approved by your referrer!`
          : `❌ Your ${deposit.package === "Credit Payment" ? "credit payment request" : "deposit"} has been rejected. Reason: ${rejectionReason || "Not specified"}`;
      await telegramService.sendMessage(deposit.user.telegramChatId, message);
    }

    res.json({ message: `Deposit ${action}d successfully`, deposit });
  } catch (error) {
    console.error("Process referral deposit error:", error);
    res.status(500).json({ message: "Server error processing deposit" });
  }
});

module.exports = router;
