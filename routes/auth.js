const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const User = require("../models/User");
const Commission = require("../models/Commission");
const authMiddleware = require("../middleware/auth");
const telegramService = require("../services/telegram");
const dotenv = require("dotenv");
const router = express.Router();
require("dotenv").config();
const sendEmail = require("../config/emailverification");

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || "your-secret-key", {
    expiresIn: "30d",
  });
};

const REFERRAL_REWARD_TIERS = [
  { threshold: 10, amount: 4999 },
  { threshold: 5, amount: 999 },
  { threshold: 4, amount: 499 },
  { threshold: 3, amount: 199 },
  { threshold: 2, amount: 99 },
  { threshold: 1, amount: 49 },
];

const getDailyReferralRewardAmount = (count) => {
  for (const tier of REFERRAL_REWARD_TIERS) {
    if (count >= tier.threshold) {
      return tier.amount;
    }
  }
  return 0;
};

// Register
router.post("/register", async (req, res) => {
  try {
    const {
      fullName,
      email,
      phoneNumber,
      password,
      referralCode,
      paymentMethods,
    } = req.body;

    // Validate required fields
    if (
      !fullName?.trim() ||
      !email?.trim() ||
      !phoneNumber?.trim() ||
      !password
    ) {
      return res.status(400).json({
        message: "Full name, email, phone number, and password are required.",
      });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters long." });
    }

    // Check if user already exists by email or phone
    const existingByEmail = await User.findOne({ email });
    if (existingByEmail) {
      return res
        .status(400)
        .json({ message: "User already exists with this email" });
    }

    const existingByPhone = await User.findOne({ phoneNumber });
    if (existingByPhone) {
      return res
        .status(400)
        .json({ message: "User already exists with this phone number" });
    }

    // referral code must be provided and must match an existing user
    if (!referralCode?.trim()) {
      return res.status(400).json({ message: "Referral code is required." });
    }

    const referrer = await User.findOne({ referralCode: referralCode.trim() });
    if (!referrer) {
      return res.status(400).json({ message: "Invalid referral code" });
    }

    // Generate unique referral code
    let newReferralCode;
    let isUnique = false;
    while (!isUnique) {
      newReferralCode = generateReferralCode();
      const existing = await User.findOne({ referralCode: newReferralCode });
      if (!existing) isUnique = true;
    }

    // Create user
    const user = new User({
      fullName,
      email,
      phoneNumber,
      password,
      referralCode: newReferralCode,
      referredBy: referrer?._id,
      level: referrer ? referrer.level + 1 : 1,
    });

    // Grant registration video reward: 32 ETB per day for 3 days
    const now = new Date();
    user.registrationReward = {
      startAt: now,
      expiresAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
      amountPerDay: 32,
      daysTotal: 3,
      daysClaimed: 0,
    };

    await user.save();

    const providedPaymentMethods = Array.isArray(paymentMethods)
      ? paymentMethods
      : [];
    const validPaymentMethods = providedPaymentMethods.filter((method) => {
      if (!method || !method.type) return false;
      if (method.type === "bank") {
        return Boolean(
          method.bankName?.trim() ||
            method.accountNumber?.trim() ||
            method.accountName?.trim(),
        );
      }
      if (method.type === "mobile_money") {
        return Boolean(
          method.accountName?.trim() || method.phoneNumber?.trim(),
        );
      }
      return false;
    });

    if (validPaymentMethods.length === 0) {
      return res.status(400).json({
        message: "Please provide at least one valid payment method.",
      });
    }

    if (validPaymentMethods.length > 0) {
      const MerchantAccount = require("../models/MerchantAccount");
      const errors = [];
      for (const [index, method] of validPaymentMethods.entries()) {
        const methodErrors = {};
        if (method.type === "bank") {
          if (!method.accountNumber?.trim()) {
            methodErrors.accountNumber = "Bank account number is required.";
          }
          if (!method.bankName?.trim()) {
            methodErrors.bankName = "Bank name is required.";
          }
        } else if (method.type === "mobile_money") {
          if (!method.phoneNumber?.trim()) {
            methodErrors.phoneNumber = "Phone number is required.";
          }
        } else {
          methodErrors.type = "Invalid payment method type.";
        }

        if (Object.keys(methodErrors).length > 0) {
          errors.push({
            index,
            type: method.type,
            errors: methodErrors,
          });
        }
      }

      if (errors.length > 0) {
        return res.status(400).json({
          message: "Please fix the payment method fields.",
          errors,
        });
      }

      for (const method of validPaymentMethods) {
        const account = new MerchantAccount({
          user: user._id,
          name:
            method.name ||
            (method.type === "bank" ? "Bank Transfer" : "Telebirr"),
          type: method.type,
          accountNumber:
            method.type === "bank" ? method.accountNumber?.trim() : undefined,
          accountName: method.accountName?.trim() || "",
          bankName:
            method.type === "bank" ? method.bankName?.trim() : undefined,
          phoneNumber:
            method.type === "mobile_money"
              ? method.phoneNumber?.trim()
              : undefined,
          instructions: method.instructions || "",
        });
        await account.save();
      }
    }

    // Update referrer's direct referrals count
    if (referrer) {
      await User.findByIdAndUpdate(referrer._id, {
        $inc: { directReferrals: 1, totalTeamSize: 1 },
      });

      // Update team sizes up the chain
      await updateTeamSizesUpChain(referrer._id);

      // Referral rewards are now granted when the referred user completes their first deposit.
      if (referrer.telegramChatId) {
        await telegramService.sendMessage(
          referrer.telegramChatId,
          `🎉 New referral! ${fullName} just joined using your referral code.`,
        );
      }
    }

    // Generate token
    const token = generateToken(user._id);

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({
      message: "User registered successfully",
      token,
      user: userResponse,
    });
  } catch (error) {
    console.error("Registration error:", error);
    // Handle duplicate key error from MongoDB (in case of race conditions)
    if (error && error.code === 11000) {
      const dupKey = Object.keys(error.keyValue || {})[0];
      const field = dupKey || "field";
      return res.status(400).json({ message: `${field} already exists` });
    }
    res.status(500).json({ message: "Server error during registration" });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Check if account is locked
    if (user.isLocked) {
      return res.status(423).json({
        message:
          "Account temporarily locked due to too many failed login attempts. Please try again later.",
      });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await user.incLoginAttempts();
      return res.status(400).json({ message: "Invalid credentials" });
    }

    if (!user.isActive) {
      return res
        .status(403)
        .json({ message: "Account is deactivated. Please contact support." });
    }

    // Reset login attempts on successful login
    if (user.loginAttempts > 0) {
      await user.resetLoginAttempts();
    }

    // Update last login
    user.lastLoginAt = new Date();
    await user.save();

    // Generate token
    const token = generateToken(user._id);

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.json({
      message: "Login successful",
      token,
      user: userResponse,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error during login" });
  }
});

// Get current user
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    res.json({ user });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Forgot password
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res
        .status(404)
        .json({ message: "User not found with this email" });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await user.save();
    // Send email
    const frontendUrl = process.env.FRONTEND_URL 
    const resetUrl = `${frontendUrl.replace(/\/$/, "")}/reset-password?token=${resetToken}`;
// const resetUrl = `http://molivetradingplc.com/reset-password?token=${resetToken}`;

    const resetEmail = await sendEmail({
      sendTo: email,
      subject: "Password Reset Request",
      html: `
      <h2>Password Reset Request</h2>
      <p>You requested a password reset for your molive Trading account.</p>
      <p>Click the link below to reset your password:</p>
      <a href="${resetUrl}" style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reset Password</a>
      <p>This link will expire in 1 hour.</p>
      <p>If you didn't request this, please ignore this email.</p>
      <p>Best regards,<br>molive Trading</p>
    `,
    });

    res.json({ message: "Password reset email sent" });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ message: "Server error sending reset email" });
  }
});

// Reset password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res
        .status(400)
        .json({ message: "Invalid or expired reset token" });
    }

    // Update password
    user.password = password;
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    res.json({ message: "Password reset successful" });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ message: "Server error resetting password" });
  }
});

// Helper functions
function generateReferralCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function updateTeamSizesUpChain(userId) {
  const user = await User.findById(userId);
  if (user && user.referredBy) {
    await User.findByIdAndUpdate(user.referredBy, {
      $inc: { totalTeamSize: 1 },
    });
    await updateTeamSizesUpChain(user.referredBy);
  }
}

module.exports = router;
