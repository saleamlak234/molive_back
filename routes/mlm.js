const express = require('express');
const User = require('../models/User');
const Commission = require('../models/Commission');

const router = express.Router();

// Get MLM tree
router.get('/tree', async (req, res) => {
  try {
    const userId = req.user._id;
    
    const tree = await buildMLMTree(userId);
    
    res.json({ tree });
  } catch (error) {
    console.error('Get MLM tree error:', error);
    res.status(500).json({ message: 'Server error fetching MLM tree' });
  }
});

// Get MLM statistics
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user._id;

    // Get direct referrals
    const directReferrals = await User.countDocuments({ referredBy: userId });

    // Get level counts
    const level2Members = await User.countDocuments({
      referredBy: { $in: await User.find({ referredBy: userId }).distinct('_id') }
    });

    const level2Users = await User.find({
      referredBy: { $in: await User.find({ referredBy: userId }).distinct('_id') }
    }).distinct('_id');

    const level3Members = await User.countDocuments({
      referredBy: { $in: level2Users }
    });

    const level3Users = await User.find({
      referredBy: { $in: level2Users }
    }).distinct('_id');

    const level4Members = await User.countDocuments({
      referredBy: { $in: level3Users }
    });

    // Total network size
    const totalNetwork = directReferrals + level2Members + level3Members + level4Members;

    // Total commissions earned
    const totalCommissionsResult = await Commission.aggregate([
      { $match: { user: userId } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const totalCommissionsEarned = totalCommissionsResult[0]?.total || 0;

    res.json({
      totalNetwork,
      directReferrals,
      level2Members,
      level3Members,
      level4Members,
      totalCommissionsEarned
    });
  } catch (error) {
    console.error('Get MLM stats error:', error);
    res.status(500).json({ message: 'Server error fetching MLM statistics' });
  }
});

// Helper function to build MLM tree
async function buildMLMTree(userId, level = 0, maxLevel = 4) {
  if (level >= maxLevel) return null;

  const user = await User.findById(userId).select('-password');
  if (!user) return null;

  // Get direct referrals
  const directReferrals = await User.find({ referredBy: userId }).select('-password');
  
  // Get commission totals for this user
  const commissionTotal = await Commission.aggregate([
    { $match: { user: userId } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  const children = [];
  for (const referral of directReferrals) {
    const childTree = await buildMLMTree(referral._id, level + 1, maxLevel);
    if (childTree) {
      children.push(childTree);
    }
  }

  return {
    id: user._id.toString(),
    fullName: user.fullName,
    email: user.email,
    phoneNumber: user.phoneNumber,
    level: level + 1,
    directReferrals: user.directReferrals,
    totalDeposits: user.totalDeposits,
    totalCommissions: commissionTotal[0]?.total || 0,
    joinedAt: user.createdAt,
    isActive: user.isActive,
    children
  };
}

module.exports = router;