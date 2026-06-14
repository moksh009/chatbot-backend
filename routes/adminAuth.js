'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const AdminTeamMember = require('../models/AdminTeamMember');
const { adminLoginLimiter } = require('../middleware/adminRateLimits');
const { protect } = require('../middleware/auth');
const { sendEmail } = require('../utils/core/emailService');

const router = express.Router();

function signAdminToken(member) {
  return jwt.sign(
    {
      type: 'admin_team',
      adminMemberId: member._id,
      role: member.role,
      permissions: member.permissions,
      email: member.email,
    },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

router.post('/login', adminLoginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const member = await AdminTeamMember.findOne({ email: String(email || '').toLowerCase(), isActive: true });
    if (!member || !(await member.matchPassword(password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    member.lastLoginAt = new Date();
    member.lastLoginIp = req.ip || '';
    await member.save();
    const token = signAdminToken(member);
    res.json({
      token,
      member: {
        id: member._id,
        email: member.email,
        name: member.name,
        role: member.role,
        permissions: member.permissions,
        allowedClientIds: member.allowedClientIds,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/me', protect, async (req, res) => {
  if (req.user?.role === 'SUPER_ADMIN') {
    return res.json({
      type: 'legacy_super_admin',
      email: req.user.email,
      name: req.user.name,
      role: 'SUPER_ADMIN',
      permissions: AdminTeamMember.applyRoleTemplate('SUPER_ADMIN'),
      allowedClientIds: [],
    });
  }
  const member = await AdminTeamMember.findById(req.user?.adminMemberId).lean();
  if (!member) return res.status(404).json({ message: 'Not found' });
  res.json({ type: 'admin_team', ...member });
});

router.post('/accept-invite', async (req, res) => {
  try {
    const { token, password, name } = req.body || {};
    const member = await AdminTeamMember.findOne({
      inviteToken: token,
      inviteExpiresAt: { $gt: new Date() },
      isActive: true,
    });
    if (!member) return res.status(400).json({ message: 'Invalid or expired invite' });
    member.passwordHash = await bcrypt.hash(password, 10);
    if (name) member.name = name;
    member.inviteToken = '';
    member.inviteExpiresAt = null;
    await member.save();
    res.json({ success: true, token: signAdminToken(member) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/members', protect, async (req, res) => {
  if (req.user?.role !== 'SUPER_ADMIN' && !req.user?.permissions?.manageTeam) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  try {
    const rows = await AdminTeamMember.find({ isActive: true })
      .select('email name role permissions allowedClientIds lastLoginAt createdAt passwordHash inviteExpiresAt')
      .sort({ createdAt: -1 })
      .lean();
    const members = rows.map((m) => ({
      _id: m._id,
      email: m.email,
      name: m.name,
      role: m.role,
      permissions: m.permissions,
      allowedClientIds: m.allowedClientIds,
      lastLoginAt: m.lastLoginAt,
      invitedAt: m.createdAt,
      invitePending: !m.passwordHash,
      status: !m.passwordHash ? 'pending' : 'active',
      isActive: true,
    }));
    res.json({ members });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/members/:id', protect, async (req, res) => {
  if (req.user?.role !== 'SUPER_ADMIN' && !req.user?.permissions?.manageTeam) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  try {
    const { permissions, role, allowedClientIds, isActive } = req.body || {};
    const member = await AdminTeamMember.findById(req.params.id);
    if (!member) return res.status(404).json({ message: 'Not found' });
    if (role) {
      member.role = role;
      member.permissions = AdminTeamMember.applyRoleTemplate(role);
    }
    if (permissions) member.permissions = { ...member.permissions, ...permissions };
    if (allowedClientIds) member.allowedClientIds = allowedClientIds;
    if (typeof isActive === 'boolean') member.isActive = isActive;
    await member.save();
    res.json({ success: true, member });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/invite', protect, async (req, res) => {
  if (req.user?.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'Super admin only' });
  }
  try {
    const { email, name, role = 'VIEWER', permissions, allowedClientIds = [] } = req.body || {};
    const inviteToken = crypto.randomBytes(24).toString('hex');
    const member = await AdminTeamMember.create({
      email: String(email).toLowerCase(),
      name: name || email,
      role,
      permissions: permissions || AdminTeamMember.applyRoleTemplate(role),
      allowedClientIds,
      inviteToken,
      inviteExpiresAt: new Date(Date.now() + 72 * 3600 * 1000),
      createdBy: req.user._id,
    });
    const dashUrl = process.env.FRONTEND_URL || 'https://dash.topedgeai.com';
    const inviteUrl = `${dashUrl.replace(/\/$/, '')}/admin/accept-invite?token=${inviteToken}`;
    try {
      await sendEmail({
        to: member.email,
        subject: 'You are invited to TopEdge Admin',
        text: `You have been invited to TopEdge Admin as ${role}.\n\nAccept your invite: ${inviteUrl}\n\nThis link expires in 72 hours.`,
        html: `<p>You have been invited to TopEdge Admin as <strong>${role}</strong>.</p><p><a href="${inviteUrl}">Accept invitation</a></p><p>This link expires in 72 hours.</p>`,
      });
    } catch {
      /* email optional in dev */
    }
    res.json({
      success: true,
      memberId: member._id,
      inviteToken,
      inviteUrl,
      emailSent: true,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/members/:id', protect, async (req, res) => {
  if (req.user?.role !== 'SUPER_ADMIN' && !req.user?.permissions?.manageTeam) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  try {
    const member = await AdminTeamMember.findById(req.params.id);
    if (!member) return res.status(404).json({ message: 'Not found' });
    member.isActive = false;
    member.inviteToken = '';
    await member.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
