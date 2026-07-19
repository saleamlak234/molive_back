// // jobs/dailyVideoRewards.js
// const cron = require("node-cron");
// const Deposit = require("../models/Deposit");
// const User = require("../models/User");
// const VideoWatch = require("../models/VideoWatch");
// const Video = require("../models/Video");
// const Commission = require("../models/Commission");
// // Admin video reward recording removed per request

// const PACKAGES = [
//   { name: "8th Stock Package", price: 32000, dailyReturn: 11040 },
//   { name: "7th Stock Package", price: 160000, dailyReturn: 5520 },
//   { name: "6th Stock Package", price: 80000, dailyReturn: 2750 },
//   { name: "5th Stock Package", price: 40000, dailyReturn: 1350 },
//   { name: "4th Stock Package", price: 20000, dailyReturn: 670 },
//   { name: "3rd Stock Package", price: 10000, dailyReturn: 330 },
//   { name: "2nd Stock Package", price: 5000, dailyReturn: 162 },
//   { name: "1st Stock Package", price: 2500, dailyReturn: 80 },
// ];

// const UPLINE_RATES = [0.05, 0.03, 0.01]; // 5%, 3%, 1%

// let isRunning = false;

// // Distribute upline commissions from video rewards
// async function distributeVideoRewardCommissions(user, totalReward) {
//   // Safety: do not distribute commissions if the source user has no deposit or has credit issues
//   if (
//     !user ||
//     !user.hasMadeDeposit ||
//     user.creditBlocked ||
//     user.pendingUplineCredit > 0
//   ) {
//     console.log(
//       `⚠️ Skipping upline commissions for user ${user && user._id}: no deposit or credit issue`,
//       {
//         hasMadeDeposit: user && user.hasMadeDeposit,
//         creditBlocked: user && user.creditBlocked,
//         pendingCredit: user && user.pendingUplineCredit,
//       },
//     );
//     return;
//   }
//   let currentUser = await User.findById(user.referredBy);
//   let level = 1;

//   while (currentUser && level <= UPLINE_RATES.length) {
//     const commissionAmount = Math.round(totalReward * UPLINE_RATES[level - 1]);

//     // Add commission to upline balance
//     await User.findByIdAndUpdate(currentUser._id, {
//       $inc: {
//         totalCommissions: commissionAmount,
//       },
//     });

//     await Commission.create({
//       user: currentUser._id,
//       fromUser: user._id,
//       amount: commissionAmount,
//       level,
//       type: "dailyReferral",
//       description: `Daily video referral commission from ${user.fullName}`,
//     });

//     console.log(
//       `Video reward commission: ${commissionAmount} ETB to level ${level} from ${user.fullName}`,
//     );

//     currentUser = await User.findById(currentUser.referredBy);
//     level++;
//   }
// }

// // Main job: runs at 23:59 (one minute before midnight)
// // This calculates video-based rewards BEFORE the daily video reset
// cron.schedule(
//   "59 23 * * *", // 23:59 every day
//   async () => {
//     console.log(
//       "📹 Daily video rewards job started at:",
//       new Date().toISOString(),
//     );
//     if (isRunning) {
//       console.log("Skipping: Previous instance still running");
//       return;
//     }
//     isRunning = true;

//     try {
//       const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

//       // Get all users
//       const users = await User.find({});

//       for (const user of users) {
//         // Skip users with no deposit — also skip any upline commissions
//         if (!user.hasMadeDeposit) {
//           console.log(
//             `🔒 User ${user._id} skipped: no deposit — no daily return or upline commissions`,
//           );
//           continue;
//         }

//         // Get user's daily return amount
//         const latestDeposit = await Deposit.findOne({
//           status: "completed",
//           isUpgraded: false,
//           package: { $ne: "Credit Payment" },
//           $or: [{ userID: user._id }, { user: user._id }],
//         }).sort({ createdAt: -1 });

//         if (!latestDeposit || !latestDeposit.totalAmount) {
//           continue;
//         }

//         // Block all rewards if user has pending credit or account is blocked
//         if (user.creditBlocked || user.pendingUplineCredit > 0) {
//           console.log(
//             `❌ User ${user._id} (${user.fullName}) blocked: CREDIT ISSUE`,
//             {
//               creditBlocked: user.creditBlocked,
//               pendingCredit: user.pendingUplineCredit,
//             },
//           );
//           console.log(`   ⚠️ No daily return granted (blocked due to credit)`);
//           console.log(
//             `   ⚠️ No upline 5/3/1 commissions distributed (blocked due to credit)`,
//           );
//           continue;
//         }

//         const packageDetails = PACKAGES.find(
//           (pkg) => latestDeposit.totalAmount >= pkg.price,
//         );

//         if (!packageDetails) {
//           continue;
//         }

//         const dailyReturn = packageDetails.dailyReturn;

//         const totalAvailableVideos = await Video.countDocuments({
//           isActive: true,
//         });

//         if (totalAvailableVideos === 0) {
//           console.log(`User ${user._id} skipped: no active videos available`);
//           continue;
//         }

//         const videosWatchedToday = await VideoWatch.countDocuments({
//           user: user._id,
//           watchDate: today,
//           fullWatch: true,
//         });

//         if (videosWatchedToday < totalAvailableVideos) {
//           console.log(
//             `User ${user._id} watched ${videosWatchedToday}/${totalAvailableVideos} videos today; not eligible for full daily return`,
//           );
//           continue;
//         }

//         // Grant daily return (only if no credit issues - already checked above)
//         await User.findByIdAndUpdate(user._id, {
//           $inc: { balance: dailyReturn },
//         });

//         await Commission.create({
//           user: user._id,
//           fromUser: user._id,
//           amount: dailyReturn,
//           level: 0,
//           type: "dailyReturn",
//           description: `Daily video reward for ${today}`,
//         });

//         console.log(
//           `✅ User ${user._id} received full daily video return: ${dailyReturn.toFixed(2)} ETB`,
//         );

//         // Distribute upline 5/3/1 commissions from the full daily return (only if no credit issues - already checked above)
//         await distributeVideoRewardCommissions(user, dailyReturn);
//       }

//       console.log("✅ Daily video rewards processed successfully");
//     } catch (error) {
//       console.error("❌ Error processing daily video rewards:", error);
//     } finally {
//       isRunning = false;
//     }
//   },
//   {
//     scheduled: true,
//     timezone: "Africa/Nairobi",
//   },
// );

// module.exports = {};
