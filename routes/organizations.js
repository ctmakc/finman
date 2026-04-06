const express = require('express');
const passport = require('passport');
const Organization = require('../models/organization');

const router = express.Router();
const auth = passport.authenticate('jwt', { session: false });

// Get current org info
router.get('/', auth, async (req, res) => {
  try {
    const org = await Organization.findById(req.user.orgId);
    if (!org) return res.status(404).json({ error: true, message: 'Organization not found' });
    res.json(org);
  } catch (error) {
    console.error('Get org error:', error);
    res.status(500).json({ error: true, message: 'Failed to get organization' });
  }
});

// Update org settings (owner only)
router.patch('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: true, message: 'Only owners can update organization settings' });
    }
    const { name, plan, ai_provider, ai_model } = req.body;
    await Organization.update(req.user.orgId, { name, plan, ai_provider, ai_model });
    const org = await Organization.findById(req.user.orgId);
    res.json(org);
  } catch (error) {
    console.error('Update org error:', error);
    res.status(500).json({ error: true, message: 'Failed to update organization' });
  }
});

// List members
router.get('/members', auth, async (req, res) => {
  try {
    const members = await Organization.getMembers(req.user.orgId);
    res.json(members);
  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({ error: true, message: 'Failed to get members' });
  }
});

// Remove a member (owner only, can't remove self)
router.delete('/members/:userId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: true, message: 'Only owners can remove members' });
    }
    const userId = parseInt(req.params.userId, 10);
    if (userId === req.user.id) {
      return res.status(400).json({ error: true, message: 'Cannot remove yourself' });
    }
    await Organization.removeMember(req.user.orgId, userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: true, message: 'Failed to remove member' });
  }
});

// Create invite link (owner/admin only)
router.post('/invite', auth, async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: true, message: 'Only owners and admins can invite members' });
    }
    const { email, role = 'member' } = req.body;
    if (!email) {
      return res.status(400).json({ error: true, message: 'Email is required' });
    }
    const token = await Organization.createInvite({ orgId: req.user.orgId, email, role });
    res.json({ token, inviteUrl: `/invite/${token}` });
  } catch (error) {
    console.error('Create invite error:', error);
    res.status(500).json({ error: true, message: 'Failed to create invite' });
  }
});

// Accept invite (authenticated user)
router.post('/invite/accept/:token', auth, async (req, res) => {
  try {
    const invite = await Organization.useInvite(req.params.token, req.user.id);
    res.json({ success: true, orgId: invite.org_id, role: invite.role });
  } catch (error) {
    console.error('Accept invite error:', error);
    res.status(400).json({ error: true, message: error.message || 'Failed to accept invite' });
  }
});

module.exports = router;
