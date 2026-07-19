const User = require("../models/User");
const Deposit = require("../models/Deposit");
const Commission = require("../models/Commission");
const CreditTransfer = require("../models/CreditTransfer");
const Transaction = require("../models/Transaction");
const Video = require("../models/Video");
const VideoWatch = require("../models/VideoWatch");
const telegramService = require("./telegram");

const PACKAGE_DAILY_RETURN = {
  "8th Stock Package": 11040,
  "7th Stock Package": 5520,
  "6th Stock Package": 2750,
  "5th Stock Package": 1350,
  "4th Stock Package": 670,
  "3rd Stock Package": 330,
  "2nd Stock Package": 162,
  "1st Stock Package": 80,
};

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

function getPackagePrice(deposit) {
  if (deposit.totalAmount && deposit.totalAmount > 0) {
    return deposit.totalAmount;
  }
  if (deposit.package && packagePrices[deposit.package]) {
    return packagePrices[deposit.package];
  }
  return deposit.amount || 0;
}

function createCreditReference(userId) {
  return `CREDIT-UP-${userId}-${Date.now()}`;
}

function calculateUplineBalanceAfterApproval({
  previousBalance,
  commissionAmount,
  amountToForward,
}) {
  const balanceAfterCommission = Number(
    (Number(previousBalance || 0) + Number(commissionAmount || 0)).toFixed(2),
  );
  const forwardedAmount = Number(
    Math.max(0, Number(amountToForward || 0)).toFixed(2),
  );
  const forwardAmount = Number(
    Math.max(0, forwardedAmount - Number(previousBalance || 0)).toFixed(2),
  );
  const remainingBalance = Number(
    Math.max(0, Number(previousBalance || 0) - forwardedAmount).toFixed(2),
  );

  return {
    balanceAfterCommission,
    forwardedAmount,
    forwardAmount,
    remainingBalance,
  };
}

async function getPlatformAdmin() {
  let adminUser = await User.findOne({ role: "super_admin" });
  if (!adminUser) adminUser = await User.findOne({ role: "transaction_admin" });
  if (!adminUser) adminUser = await User.findOne({ role: "admin" });
  return adminUser;
}

function isAdminUser(user) {
  return (
    user && ["admin", "super_admin", "transaction_admin"].includes(user.role)
  );
}

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

const getTodayServer = () => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
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

const getFirstInitialDeposit = async (userId) => {
  return await Deposit.findOne({
    user: userId,
    status: "completed",
    package: { $ne: "Credit Payment" },
  }).sort({ createdAt: -1 });
};

const isUserQualifiedForDailyReferral = async (userId) => {
  const user = await User.findById(userId);
  if (!user) return { qualified: false, reason: "User not found" };
  if (user.creditBlocked) return { qualified: false, reason: "Credit blocked" };
  if (user.pendingUplineCredit > 0) return { qualified: false, reason: "Pending upline credit pending" };

  const firstDeposit = await getFirstInitialDeposit(userId);
  if (!firstDeposit) return { qualified: false, reason: "No initial deposit made" };

  const availableVideos = await Video.countDocuments({ isActive: true });
  if (availableVideos === 0) return { qualified: false, reason: "No active videos available" };

  const watchedCount = await VideoWatch.countDocuments({
    user: userId,
    watchDate: getTodayServer(),
    fullWatch: true,
  });

  if (watchedCount < availableVideos) {
    return { 
      qualified: false, 
      reason: `Not all videos watched (${watchedCount}/${availableVideos})` 
    };
  }

  return { qualified: true, reason: "Qualified" };
};

async function reconcileMissedDailyReferralCommissionsForUpline(uplineId) {
  try {
    const upline = await User.findById(uplineId);
    if (!upline) return;
    if (!upline.hasMadeDeposit) return;
    
    const uplineQualified = await isUserQualifiedForDailyReferral(uplineId);
    if (!uplineQualified.qualified) return;

    const COMMISSION_RATES = [0.05, 0.03, 0.01];
    const { start, end } = getTodayRangeServer();
    let currentLevelUserIds = [uplineId];

    for (let level = 1; level <= COMMISSION_RATES.length; level++) {
      const referrals = await User.find({
        referredBy: { $in: currentLevelUserIds },
      }).select("_id");
      if (referrals.length === 0) break;

      currentLevelUserIds = referrals.map((ref) => ref._id);
      const rate = COMMISSION_RATES[level - 1];

      for (const downlineId of currentLevelUserIds) {
        const existing = await Commission.findOne({
          user: uplineId,
          fromUser: downlineId,
          type: "dailyReferral",
          createdAt: { $gte: start, $lte: end },
        });
        if (existing) continue;

        const downlineQualified = await isUserQualifiedForDailyReferral(downlineId);
        
        const downlineDailyReturn = await Commission.findOne({
          user: downlineId,
          fromUser: downlineId,
          type: "dailyReturn",
          createdAt: { $gte: start, $lte: end },
        });
        
        if (!downlineDailyReturn) {
          // Log failure reason
          await Commission.create({
            user: uplineId,
            fromUser: downlineId,
            amount: 0,
            level: level,
            type: "dailyReferral",
            description: `Failed daily referral from ${(await User.findById(downlineId))?.fullName || "Unknown"}`,
            failureReason: `Downline did not qualify: ${downlineQualified.reason} (no daily return commission)`,
          });
          continue;
        }

        const downlineDeposit = await getFirstInitialDeposit(downlineId);
        if (!downlineDeposit) {
          await Commission.create({
            user: uplineId,
            fromUser: downlineId,
            amount: 0,
            level: level,
            type: "dailyReferral",
            description: `Failed daily referral from ${(await User.findById(downlineId))?.fullName || "Unknown"}`,
            failureReason: "Downline has no initial deposit",
          });
          continue;
        }

        const downlineReward =
          PACKAGE_DAILY_RETURN[downlineDeposit.package] || 0;
        if (downlineReward <= 0) {
          await Commission.create({
            user: uplineId,
            fromUser: downlineId,
            amount: 0,
            level: level,
            type: "dailyReferral",
            description: `Failed daily referral from ${(await User.findById(downlineId))?.fullName || "Unknown"}`,
            failureReason: "Downline deposit package has no daily return",
          });
          continue;
        }

        const commissionAmount = Math.round(downlineReward * rate);
        if (commissionAmount <= 0) {
          await Commission.create({
            user: uplineId,
            fromUser: downlineId,
            amount: 0,
            level: level,
            type: "dailyReferral",
            description: `Failed daily referral from ${(await User.findById(downlineId))?.fullName || "Unknown"}`,
            failureReason: "Commission amount calculated to zero",
          });
          continue;
        }

        await User.findByIdAndUpdate(uplineId, {
          $inc: {
            totalCommissions: commissionAmount,
            balance: commissionAmount,
          },
        });

        const downlineUser = await User.findById(downlineId).select("fullName");
        await Commission.create({
          user: uplineId,
          fromUser: downlineId,
          amount: commissionAmount,
          level,
          type: "dailyReferral",
          sourceTransaction: downlineDeposit._id,
          sourceModel: "Deposit",
          description: `Retroactive daily video referral commission from ${downlineUser?.fullName || downlineId}`,
        });
      }
    }
  } catch (error) {
    console.error(
      "Error reconciling missed daily referral commissions:",
      error,
    );
  }
}

const getUplineIds = async (userId, maxLevels = 3) => {
  const uplineIds = [];
  let currentUser = await User.findById(userId).select("referredBy");

  for (let level = 1; level <= maxLevels && currentUser; level += 1) {
    if (!currentUser.referredBy) break;
    const parentId = currentUser.referredBy;
    uplineIds.push(parentId);
    currentUser = await User.findById(parentId).select("referredBy");
  }

  return uplineIds;
};

async function reconcileMissedDailyReferralCommissionsForUplineChain(userId) {
  const uplineIds = await getUplineIds(userId);
  for (const uplineId of uplineIds) {
    await reconcileMissedDailyReferralCommissionsForUpline(uplineId);
  }
}

// Referral reward tiers based on number of direct referrals per day
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

async function createCreditTransfer({
  fromUser,
  toUser,
  deposit,
  amount,
  receiptUrl = null,
}) {
  if (!fromUser || !toUser || !deposit || amount <= 0) {
    return null;
  }

  const creditTransfer = new CreditTransfer({
    fromUser: fromUser._id || fromUser,
    toUser: toUser._id || toUser,
    deposit: deposit._id || deposit,
    amount,
    reference: createCreditReference(fromUser._id || fromUser),
    receiptUrl,
    status: "pending",
    dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  await creditTransfer.save();
  return creditTransfer;
}

async function settlePendingUplineCreditFromBalance(userId) {
  try {
    const user = await User.findById(userId);
    if (!user) return { paidAmount: 0, remainingPending: 0 };

    const pendingAmount = Number(user.pendingUplineCredit || 0);
    if (pendingAmount <= 0) {
      if (user.creditBlocked) {
        await User.findByIdAndUpdate(userId, {
          $set: { pendingUplineCredit: 0, creditBlocked: false },
        });
      }
      return { paidAmount: 0, remainingPending: 0 };
    }

    const balanceBefore = Number(user.balance || 0);
    if (balanceBefore <= 0) {
      return { paidAmount: 0, remainingPending: pendingAmount };
    }

    const { forwardAmount: remainingPending } =
      calculateUplineBalanceAfterApproval({
        previousBalance: balanceBefore,
        commissionAmount: 0,
        amountToForward: pendingAmount,
      });
    const amountToSettle = Number(
      Math.max(0, pendingAmount - remainingPending).toFixed(2),
    );
    if (amountToSettle <= 0) {
      return { paidAmount: 0, remainingPending: pendingAmount };
    }

    const balanceAfter = Number((balanceBefore - amountToSettle).toFixed(2));

    await User.findByIdAndUpdate(userId, {
      $set: {
        balance: balanceAfter,
        pendingUplineCredit: remainingPending,
        creditBlocked: remainingPending > 0,
      },
    });

    await Transaction.create({
      user: userId,
      type: "balance_adjustment",
      direction: "debit",
      amount: amountToSettle,
      balanceBefore,
      balanceAfter,
      description: `Settled ${amountToSettle.toLocaleString()} ETB of pending upline credit from balance`,
      sourceModel: "Commission",
    });

    return { paidAmount: amountToSettle, remainingPending };
  } catch (error) {
    console.error("Settle pending upline credit from balance error:", error);
    return { paidAmount: 0, remainingPending: 0 };
  }
}

async function payPendingCredits(userId) {
  try {
    const pendingTransfers = await CreditTransfer.find({
      fromUser: userId,
      status: "pending",
    });

    const remainingCreditAmount = pendingTransfers.reduce(
      (sum, transfer) => sum + transfer.amount,
      0,
    );

    const user = await User.findById(userId);
    if (!user) return;

    if (isAdminUser(user)) {
      await User.findByIdAndUpdate(userId, {
        $set: {
          pendingUplineCredit: 0,
          creditBlocked: false,
        },
      });
      await reconcileMissedDailyReferralCommissionsForUpline(userId);
      return;
    }

    const creditBlocked = pendingTransfers.length > 0;
    await User.findByIdAndUpdate(userId, {
      $set: {
        pendingUplineCredit: remainingCreditAmount,
        creditBlocked,
      },
    });

    await settlePendingUplineCreditFromBalance(userId);

    const updatedUser = await User.findById(userId).select(
      "pendingUplineCredit creditBlocked",
    );
    if (!updatedUser?.creditBlocked) {
      await reconcileMissedDailyReferralCommissionsForUpline(userId);
    }
  } catch (error) {
    console.error("Pay pending credits error:", error);
  }
}

async function settleCreditPaymentDeposit(deposit, approverId = null) {
  try {
    const user = await User.findById(deposit.user).populate("referredBy");
    if (!user) return;

    const pendingTransfers = await CreditTransfer.find({
      fromUser: user._id,
      status: "pending",
    }).sort({ createdAt: 1 });

    if (pendingTransfers.length === 0) {
      await User.findByIdAndUpdate(user._id, {
        $set: { pendingUplineCredit: 0, creditBlocked: false },
      });
      return;
    }

    for (const transfer of pendingTransfers) {
      await CreditTransfer.findByIdAndUpdate(transfer._id, {
        status: "paid",
        paidAt: new Date(),
        receiptUrl: deposit.receiptUrl || transfer.receiptUrl,
      });

      if (approverId && transfer.toUser.toString() === approverId.toString()) {
        await approveCreditTransfer(transfer._id, approverId);
      } else {
        const directUpline = await User.findById(transfer.toUser);
        if (directUpline && directUpline.telegramChatId) {
          await telegramService.sendMessage(
            directUpline.telegramChatId,
            `💰 Credit Payment Deposit Received!\n` +
              `Amount: ${transfer.amount.toLocaleString()} ETB\n` +
              `From: ${user.fullName}\n` +
              `Status: Pending your approval.`,
          );
        }
      }
    }

    // Once the payment deposit is settled, the sender no longer carries upline pending credit.
    await User.findByIdAndUpdate(user._id, {
      $set: { pendingUplineCredit: 0, creditBlocked: false },
    });

    await payPendingCredits(user._id);

    if (user.telegramChatId) {
      await telegramService.sendMessage(
        user.telegramChatId,
        `✅ Your pending credit payments have been submitted!\n` +
          `Total: ${deposit.amount.toLocaleString()} ETB\n` +
          `Status: Awaiting approval from your direct upline`,
      );
    }
  } catch (error) {
    console.error("Settle credit payment deposit error:", error);
  }
}

async function processUpgradeDeposit(deposit, depositUser) {
  const adminUser = await getPlatformAdmin();
  if (!adminUser) return;

  const previousDeposit = deposit.upgradedFrom
    ? await Deposit.findById(deposit.upgradedFrom)
    : null;
  const previousTotal = previousDeposit ? getPackagePrice(previousDeposit) : 0;
  const newTotal = getPackagePrice(deposit);
  const upgradeDifference = Number((newTotal - previousTotal).toFixed(2));
  const depositUserId = deposit.user?._id || deposit.user;
  const user =
    depositUser ||
    (deposit.user && deposit.user.fullName
      ? deposit.user
      : await User.findById(depositUserId));

  // Update user's total deposit to the new package total, not additive.
  await User.findByIdAndUpdate(user._id, {
    $set: {
      totalDeposits: newTotal,
      hasMadeDeposit: true,
    },
  });

  const fromPackage = previousDeposit?.package || "previous package";
  const toPackage = deposit.package || "upgrade package";

  const adminDescription = user
    ? `Approved upgrade from ${fromPackage} to ${toPackage} for ${user.fullName}`
    : `Approved upgrade deposit from user ${depositUserId}`;

  const adminCommission = new Commission({
    user: adminUser._id,
    fromUser: depositUserId,
    amount: deposit.amount,
    level: 0,
    type: "deposit",
    description: adminDescription,
    sourceTransaction: deposit._id,
    sourceModel: "Deposit",
  });

  await adminCommission.save();
  await User.findByIdAndUpdate(adminUser._id, {
    $inc: { totalDeposits: deposit.amount },
  });

  if (upgradeDifference > 0) {
    const commissionRates = [0.08, 0.06, 0.04];
    const uplineIds = await getUplineIds(depositUserId);

    for (let i = 0; i < commissionRates.length; i += 1) {
      const uplineId = uplineIds[i];
      if (!uplineId) break;

      const commissionAmount = Number(
        (upgradeDifference * commissionRates[i]).toFixed(2),
      );
      if (commissionAmount <= 0) continue;

      const uplineUser = await User.findByIdAndUpdate(
        uplineId,
        {
          $inc: {
            balance: commissionAmount,
            totalCommissions: commissionAmount,
          },
        },
        { new: true },
      );

      await Commission.create({
        user: uplineId,
        fromUser: depositUserId,
        amount: commissionAmount,
        level: i + 1,
        type: "upgrade",
        description: `Upgrade commission from ${user.fullName || depositUserId}'s package upgrade to ${toPackage}`,
        sourceTransaction: deposit._id,
        sourceModel: "Deposit",
      });

      if (uplineUser && uplineUser.telegramChatId) {
        await telegramService.sendMessage(
          uplineUser.telegramChatId,
          `💰 Upgrade commission earned!
` +
            `Amount: ${commissionAmount.toLocaleString()} ETB
` +
            `From ${user.fullName || "your downline"}'s package upgrade to ${toPackage}`,
        );
      }
    }
  }
}

async function processDepositApproval(deposit, approverId = null) {
  try {
    if (deposit.package === "Credit Payment") {
      await settleCreditPaymentDeposit(deposit, approverId);
      return;
    }

    const depositUser = await User.findById(deposit.user).populate(
      "referredBy",
    );
    if (!depositUser) return;

    if (deposit.upgradedFrom) {
      await processUpgradeDeposit(deposit, depositUser);
      return;
    }

    const packagePrice = getPackagePrice(deposit);
    const isFirstDeposit = !depositUser.hasMadeDeposit;

    await User.findByIdAndUpdate(depositUser._id, {
      $inc: { totalDeposits: packagePrice },
      $set: { hasMadeDeposit: true },
    });

    if (isFirstDeposit && depositUser.referredBy) {
      const referrerId = depositUser.referredBy._id || depositUser.referredBy;
      const updatedReferrer = await User.findByIdAndUpdate(
        referrerId,
        {
          $inc: { qualifiedDirectReferrals: 1, qualifiedTeamSize: 1 },
        },
        { new: true },
      );
      if (updatedReferrer) {
        await updatedReferrer.updateVipLevel();
      }
      await updateQualifiedTeamSizesUpChain(referrerId);

      const referredUserBonus = 49;
      await User.findByIdAndUpdate(depositUser._id, {
        $inc: {
          balance: referredUserBonus,
          totalCommissions: referredUserBonus,
        },
      });

      await Commission.create({
        user: depositUser._id,
        fromUser: referrerId,
        amount: referredUserBonus,
        level: 0,
        type: "directReferral",
        description: `Referral signup bonus from ${updatedReferrer.fullName}`,
      });
    }

    if (deposit.upgradedFrom) {
      await processUpgradeDeposit(deposit);
      return;
    }

    const commissionRates = [0.08, 0.06, 0.04];
    const firstUpline = depositUser.referredBy
      ? await User.findById(depositUser.referredBy)
      : null;

    if (!firstUpline) {
      return;
    }

    const level = 1;
    const commissionAmount = Number(
      (packagePrice * commissionRates[level - 1]).toFixed(2),
    );
    const previousBalance = Number(firstUpline.balance || 0);
    const remainingAfterCommission = Number(
      (packagePrice - commissionAmount).toFixed(2),
    );
    const { forwardAmount, remainingBalance } =
      calculateUplineBalanceAfterApproval({
        previousBalance,
        commissionAmount,
        amountToForward: remainingAfterCommission,
      });

    const commission = new Commission({
      user: firstUpline._id,
      fromUser: depositUser._id,
      amount: commissionAmount,
      level,
      type: "deposit",
      description: `Level ${level} commission from ${depositUser.fullName}'s deposit`,
      sourceTransaction: deposit._id,
      sourceModel: "Deposit",
    });
    await commission.save();

    await User.findByIdAndUpdate(firstUpline._id, {
      $inc: {
        totalCommissions: commissionAmount,
      },
      $set: {
        balance: remainingBalance,
      },
    });

    if (firstUpline.telegramChatId) {
      await telegramService.sendMessage(
        firstUpline.telegramChatId,
        `💰 Commission earned!\n` +
          `Amount: ${commissionAmount.toLocaleString()} ETB\n` +
          `From ${depositUser.fullName}'s deposit (level ${level})`,
      );
    }

    if (forwardAmount > 0) {
      await Transaction.create({
        user: firstUpline._id,
        type: "credit_forward",
        direction: "debit",
        amount: forwardAmount,
        balanceBefore: Number((previousBalance + commissionAmount).toFixed(2)),
        balanceAfter: remainingBalance,
        description: `Forwarded ${forwardAmount.toLocaleString()} ETB to your upline after deposit approval`,
        sourceTransaction: deposit._id,
        sourceModel: "Deposit",
        relatedUser: firstUpline.referredBy,
      });

      if (isAdminUser(firstUpline)) {
        await User.findByIdAndUpdate(firstUpline._id, {
          $inc: { totalDeposits: forwardAmount },
        });
      } else if (firstUpline.referredBy) {
        await createCreditTransfer({
          fromUser: firstUpline,
          toUser: firstUpline.referredBy,
          deposit,
          amount: forwardAmount,
        });
        await payPendingCredits(firstUpline._id);
      }
    } else {
      await User.findByIdAndUpdate(firstUpline._id, {
        $set: { pendingUplineCredit: 0, creditBlocked: false },
      });
    }
  } catch (error) {
    console.error("Commission service processDepositApproval error:", error);
  }
}

async function getUplineLevel(depositUserId, targetUserId) {
  let currentUser = await User.findById(depositUserId).select("referredBy");
  for (let level = 1; level <= 3 && currentUser; level += 1) {
    if (!currentUser.referredBy) {
      return null;
    }

    const nextUpline = await User.findById(currentUser.referredBy).select(
      "referredBy",
    );
    if (!nextUpline) {
      return null;
    }

    if (nextUpline._id.toString() === targetUserId.toString()) {
      return level;
    }

    currentUser = nextUpline;
  }
  return null;
}

async function updateQualifiedTeamSizesUpChain(userId) {
  let currentUser = await User.findById(userId).select("referredBy");
  while (currentUser && currentUser.referredBy) {
    const uplineId = currentUser.referredBy._id || currentUser.referredBy;
    const upline = await User.findByIdAndUpdate(
      uplineId,
      { $inc: { qualifiedTeamSize: 1 } },
      { new: true },
    );
    if (!upline) {
      break;
    }
    await upline.updateVipLevel();
    currentUser = await User.findById(upline.referredBy).select("referredBy");
  }
}

async function approveCreditTransfer(transferId, approverId) {
  try {
    const transfer = await CreditTransfer.findById(transferId)
      .populate("fromUser")
      .populate("toUser")
      .populate("deposit");

    if (!transfer) {
      throw new Error("Credit transfer not found");
    }

    if (transfer.toUser._id.toString() !== approverId.toString()) {
      throw new Error("Only the recipient can approve this credit transfer");
    }

    if (transfer.approvalStatus !== "pending") {
      throw new Error("Transfer is not pending approval");
    }

    const approver = transfer.toUser;
    const isAdminRecipient = isAdminUser(approver);

    if (isAdminRecipient) {
      const isDirectChildTransfer =
        transfer.fromUser.referredBy &&
        transfer.fromUser.referredBy.toString() === approver._id.toString();

      if (!isDirectChildTransfer) {
        throw new Error(
          "Admin can only approve credit transfers from direct children",
        );
      }
    }

    const approverPreviousBalance = Number(approver.balance || 0);
    const packagePrice = getPackagePrice(transfer.deposit);
    const approverLevel = await getUplineLevel(
      transfer.deposit.user,
      approver._id,
    );
    const commissionRates = [0.08, 0.06, 0.04];
    const commissionAmount = Number(
      ((commissionRates[approverLevel - 1] || 0) * packagePrice).toFixed(2),
    );
    const { balanceAfterCommission, forwardAmount, remainingBalance } =
      calculateUplineBalanceAfterApproval({
        previousBalance: approverPreviousBalance,
        commissionAmount,
        amountToForward: Number(
          (transfer.amount - commissionAmount).toFixed(2),
        ),
      });

    if (commissionAmount > 0) {
      const commission = new Commission({
        user: approver._id,
        fromUser: transfer.fromUser._id,
        amount: commissionAmount,
        level: approverLevel,
        type: "credit",
        description: `Level ${approverLevel} commission from credit payment approval`,
        sourceTransaction: transfer._id,
        sourceModel: "CreditTransfer",
      });
      await commission.save();

      await User.findByIdAndUpdate(approver._id, {
        $inc: {
          balance: commissionAmount,
          totalCommissions: commissionAmount,
        },
      });

      await Transaction.create({
        user: approver._id,
        type: "commission",
        direction: "credit",
        amount: commissionAmount,
        balanceBefore: approverPreviousBalance,
        balanceAfter: balanceAfterCommission,
        description: `Commission earned from credit payment approval`,
        sourceTransaction: transfer._id,
        sourceModel: "CreditTransfer",
        relatedUser: transfer.fromUser._id,
      });

      if (approver.telegramChatId) {
        await telegramService.sendMessage(
          approver.telegramChatId,
          `💰 Commission earned!\n` +
            `Amount: ${commissionAmount.toLocaleString()} ETB\n` +
            `From credit payment approval`,
        );
      }
    }

    if (!isAdminRecipient) {
      await User.findByIdAndUpdate(approver._id, {
        $set: { balance: remainingBalance },
      });
    }

    if (forwardAmount > 0) {
      if (isAdminRecipient) {
        await User.findByIdAndUpdate(approver._id, {
          $inc: { totalDeposits: forwardAmount },
        });
      } else if (approver.referredBy) {
        await Transaction.create({
          user: approver._id,
          type: "credit_forward",
          direction: "debit",
          amount: forwardAmount,
          balanceBefore: balanceAfterCommission,
          balanceAfter: remainingBalance,
          description: `Forwarded ${forwardAmount.toLocaleString()} ETB to your upline after credit approval`,
          sourceTransaction: transfer._id,
          sourceModel: "CreditTransfer",
          relatedUser: approver.referredBy,
        });

        await User.findByIdAndUpdate(approver._id, {
          $inc: { totalCreditSent: forwardAmount },
        });

        const nextUpline = await User.findById(approver.referredBy);
        if (nextUpline) {
          await createCreditTransfer({
            fromUser: approver,
            toUser: nextUpline,
            deposit: transfer.deposit,
            amount: forwardAmount,
          });
        }
      }
    }

    await CreditTransfer.findByIdAndUpdate(transfer._id, {
      status: "paid",
      approvalStatus: "approved",
      approvedBy: approverId,
      approvedAt: new Date(),
      paidAt: new Date(),
    });

    await Transaction.create({
      user: transfer.fromUser._id,
      type: "credit_payment",
      direction: "debit",
      amount: transfer.amount,
      balanceBefore: Number(transfer.fromUser.balance || 0),
      balanceAfter: Number(transfer.fromUser.balance || 0),
      description: `Credit payment approved by ${approver.fullName}`,
      sourceTransaction: transfer._id,
      sourceModel: "CreditTransfer",
      relatedUser: approver._id,
    });

    await payPendingCredits(transfer.fromUser._id);
    await User.findByIdAndUpdate(transfer.fromUser._id, {
      $set: { pendingUplineCredit: 0, creditBlocked: false },
    });
    await payPendingCredits(approver._id);

    if (approver.telegramChatId) {
      const approvalNote = isAdminRecipient
        ? `Amount has been added to your total deposits.`
        : `Amount has been forwarded to your upline as pending credit.`;

      await telegramService.sendMessage(
        approver.telegramChatId,
        `✅ Credit Transfer Approved!\n` +
          `Amount: ${transfer.amount.toLocaleString()} ETB\n` +
          approvalNote,
      );
    }

    if (transfer.fromUser.telegramChatId) {
      await telegramService.sendMessage(
        transfer.fromUser.telegramChatId,
        `✅ Your credit transfer has been approved!\n` +
          `Amount: ${transfer.amount.toLocaleString()} ETB\n` +
          `Approved by: ${approver.fullName}`,
      );
    }

    return transfer;
  } catch (error) {
    console.error("Approve credit transfer error:", error);
    throw error;
  }
}

async function rejectCreditTransfer(transferId, approverId, reason = "") {
  try {
    const transfer = await CreditTransfer.findById(transferId)
      .populate("fromUser")
      .populate("toUser");

    if (!transfer) {
      throw new Error("Credit transfer not found");
    }

    if (transfer.toUser._id.toString() !== approverId.toString()) {
      throw new Error("Only the recipient can reject this credit transfer");
    }

    if (transfer.approvalStatus !== "pending") {
      throw new Error("Transfer is not pending approval");
    }

    // Reject the transfer
    await CreditTransfer.findByIdAndUpdate(transfer._id, {
      approvalStatus: "rejected",
      approvedBy: approverId,
      approvedAt: new Date(),
    });

    // Refund the amount back to sender's balance (since they already paid)
    await User.findByIdAndUpdate(transfer.fromUser._id, {
      $inc: { balance: transfer.amount },
    });

    // Send notifications
    if (transfer.toUser.telegramChatId) {
      await telegramService.sendMessage(
        transfer.toUser.telegramChatId,
        `❌ Credit Transfer Rejected\n` +
          `Amount: ${transfer.amount.toLocaleString()} ETB\n` +
          `From: ${transfer.fromUser.fullName}\n` +
          `Reason: ${reason || "Not specified"}`,
      );
    }

    if (transfer.fromUser.telegramChatId) {
      await telegramService.sendMessage(
        transfer.fromUser.telegramChatId,
        `❌ Your credit transfer was rejected\n` +
          `Amount: ${transfer.amount.toLocaleString()} ETB\n` +
          `By: ${transfer.toUser.fullName}\n` +
          `Reason: ${reason || "Not specified"}\n` +
          `Amount has been refunded to your balance.`,
      );
    }

    return transfer;
  } catch (error) {
    console.error("Reject credit transfer error:", error);
    throw error;
  }
}

module.exports = {
  processDepositApproval,
  getPlatformAdmin,
  createCreditTransfer,
  payPendingCredits,
  settlePendingUplineCreditFromBalance,
  approveCreditTransfer,
  rejectCreditTransfer,
  reconcileMissedDailyReferralCommissionsForUpline,
  calculateUplineBalanceAfterApproval,
  reconcileMissedDailyReferralCommissionsForUplineChain,
  isUserQualifiedForDailyReferral,
};
