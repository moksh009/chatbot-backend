const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Client = require('../models/Client');
const Conversation = require('../models/Conversation');
const { protect } = require('../middleware/auth');
const { verifyTenantScope } = require('../middleware/verifyTenantScope');
const { requireRoleCategory } = require('../middleware/requireRole');
const teamAdmin = [protect, verifyTenantScope(), requireRoleCategory('team')];
const { logActivity } = require('../utils/core/activityLogger');
const crypto = require('crypto');
const { sendTeamInviteEmail, sendAdminConfirmationEmail } = require('../utils/core/emailService');
const { checkLimit, incrementUsage } = require('../utils/core/planLimits');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { apiCache } = require('../middleware/apiCache');
const { sanitizeHubAccess, DEFAULT_AGENT_HUB_ACCESS } = require('../constants/hubSections');

const TEN_MIN_MS = 10 * 60 * 1000;

async function buildTeamWithMetrics(clientId) {
    const [users, performanceMetrics] = await Promise.all([
        User.find({ clientId }).select('-password').lean(),
        Conversation.aggregate([
            { $match: { clientId, assignedTo: { $exists: true, $ne: null } } },
            {
                $group: {
                    _id: '$assignedTo',
                    totalAssigned: { $sum: 1 },
                    resolvedCount: {
                        $sum: {
                            $cond: [{ $ne: ['$resolvedAt', null] }, 1, 0],
                        },
                    },
                    avgCsat: { $avg: '$csatScore.rating' },
                    lastActive: { $max: '$lastInteraction' },
                },
            },
        ]),
    ]);

    const metricByUser = new Map(performanceMetrics.map((m) => [String(m._id), m]));

    return users.map((user) => {
        const metric = metricByUser.get(String(user._id));
        const pendingTasks = (user.tasks || []).filter((t) => t.status !== 'completed').length;
        const completedTasks = (user.tasks || []).filter((t) => t.status === 'completed').length;
        const taskRows = (user.tasks || []).slice().sort(
            (a, b) => new Date(b.assignedAt || 0) - new Date(a.assignedAt || 0)
        );
        const lastActive = metric?.lastActive || null;
        const isOnline = lastActive && Date.now() - new Date(lastActive).getTime() < TEN_MIN_MS;

        return {
            ...user,
            id: user._id.toString(),
            metrics: {
                assignedChats: metric ? metric.totalAssigned : 0,
                resolvedChats: metric ? metric.resolvedCount : 0,
                avgCsat: metric && metric.avgCsat ? Number(metric.avgCsat.toFixed(1)) : 0,
                lastActive,
                pendingTasks,
                completedTasks,
                isOnline,
            },
            tasks: taskRows.map((t) => ({
                _id: t._id,
                title: t.title,
                description: t.description,
                type: t.type,
                priority: t.priority || 'medium',
                status: t.status,
                assignedAt: t.assignedAt,
                dueAt: t.dueAt,
                completedAt: t.completedAt,
            })),
        };
    });
}

// @route   GET /api/team
// @route   GET /api/users/team
// @desc    Team directory with Live Chat performance metrics
router.get('/', protect, apiCache(30), async (req, res) => {
    const { createTimer } = require('../utils/core/perfLogger');
    const timer = createTimer('GET /api/team', req.user?.clientId || '');
    try {
        const clientId = tenantClientId(req);
        const team = await timer.time('team.metrics', () => buildTeamWithMetrics(clientId));
        res.json({ success: true, team });
        timer.finish(`200 ok | count=${team.length}`);
    } catch (error) {
        timer.finish(`500 error=${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/team', protect, verifyTenantScope(), async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        const team = await buildTeamWithMetrics(clientId);
        res.json({ success: true, team });
    } catch (error) {
        console.error('[TeamAPI] Fetch Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

router.get('/:clientId', protect, verifyTenantScope(), async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId || clientId !== req.params.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const team = await buildTeamWithMetrics(clientId);
        res.json({ success: true, team });
    } catch (error) {
        console.error('[TeamAPI] Fetch Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});


// @route   POST /api/team/invite
// @desc    Invite a new team member (Agent)
// @access  Private (Admin only)
router.post('/invite', ...teamAdmin, async (req, res) => {
    const { name, email, hubAccess: rawHubAccess } = req.body;

    if (!name || !email) {
        return res.status(400).json({ message: 'Name and Email are required' });
    }

    try {
        // Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: 'User with this email already exists' });
        }

        const clientId = req.user.clientId;
        const client = await Client.findOne({ clientId }).select('_id plan subscriptionPlan whatsappToken phoneNumberId wabaId metaAdAccountId metaAdsToken role').lean();
        if (!client) return res.status(404).json({ message: 'Client configuration not found' });

        // --- Phase 23: Track 8 - Billing Enforcement (Agents) ---
        const limitCheck = await checkLimit(client._id, 'agents');
        if (!limitCheck.allowed) {
            return res.status(403).json({ success: false, message: limitCheck.reason });
        }

        // Generate a secure temporary password
        const tempPassword = crypto.randomBytes(4).toString('hex'); // 8 char hex

        // 1. Create the User
        const hubAccess = sanitizeHubAccess(rawHubAccess);
        const resolvedHubAccess = hubAccess.length ? hubAccess : [...DEFAULT_AGENT_HUB_ACCESS];

        const newUser = await User.create({
            name,
            email,
            password: tempPassword, // Will be hashed by User model pre-save hook
            role: 'AGENT',
            clientId,
            business_type: client.businessType || 'ecommerce',
            hubAccess: resolvedHubAccess,
        });

        // Increment usage
        await incrementUsage(client._id, 'agents', 1);

        // 2. Send Invitation Email to Agent
        const loginUrl = (process.env.FRONTEND_URL || 'https://dash.topedgeai.com') + '/login';
        await sendTeamInviteEmail(email, {
            adminName: req.user.name,
            businessName: client.name || 'Your Workspace',
            password: tempPassword,
            loginUrl
        });

        // 3. Send Confirmation Email to Admin
        await sendAdminConfirmationEmail(req.user.email, {
            agentName: name,
            agentEmail: email,
            businessName: client.name || 'Your Workspace'
        });

        res.status(201).json({
            success: true,
            message: 'Invitation sent successfully',
            user: {
                _id: newUser._id,
                name: newUser.name,
                email: newUser.email,
                role: newUser.role
            }
        });
    } catch (error) {
        console.error('[TeamAPI] Invite Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

// @route   POST /api/team/assign-task
// @desc    Assign an internal task to an agent (stored on User.tasks)
router.post('/assign-task', ...teamAdmin, async (req, res) => {
    try {
        const { agentId, title, description, priority = 'medium', dueDate } = req.body;
        if (!agentId || !title) {
            return res.status(400).json({ message: 'agentId and title are required' });
        }

        const agent = await User.findById(agentId);
        if (!agent) return res.status(404).json({ message: 'Agent not found' });
        if (agent.clientId !== req.user.clientId) {
            return res.status(403).json({ message: 'Unauthorized' });
        }

        const dueAt = dueDate ? new Date(dueDate) : null;
        const cleanDescription = description ? String(description).trim() : '';
        const normalizedPriority = ['low', 'medium', 'high', 'critical'].includes(priority)
            ? priority
            : 'medium';

        agent.tasks.push({
            title: String(title).trim(),
            description: cleanDescription,
            type: 'custom',
            priority: normalizedPriority,
            assignedBy: req.user._id,
            assignedAt: new Date(),
            dueAt: dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : undefined,
            status: 'pending',
        });
        await agent.save();

        await logActivity(req.user.clientId, {
            type: 'TEAM',
            status: 'info',
            title: 'Task assigned',
            message: `${req.user.name} assigned "${title}" to ${agent.name}`,
            metadata: { agentId: agent._id, priority },
        });

        res.status(201).json({
            success: true,
            message: 'Task assigned',
            pendingTasks: agent.tasks.filter((t) => t.status !== 'completed').length,
            task: agent.tasks[agent.tasks.length - 1],
        });
    } catch (error) {
        console.error('[TeamAPI] Assign task error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

// @route   POST /api/team/resolve-task
// @desc    Mark an agent task completed (or reopen)
router.post('/resolve-task', ...teamAdmin, async (req, res) => {
    try {
        const { agentId, taskId, status = 'completed' } = req.body;
        if (!agentId || !taskId) {
            return res.status(400).json({ message: 'agentId and taskId are required' });
        }
        const allowed = ['pending', 'in_progress', 'completed'];
        if (!allowed.includes(status)) {
            return res.status(400).json({ message: 'Invalid task status' });
        }

        const agent = await User.findById(agentId);
        if (!agent) return res.status(404).json({ message: 'Agent not found' });
        if (agent.clientId !== req.user.clientId) {
            return res.status(403).json({ message: 'Unauthorized' });
        }

        const task = agent.tasks.id(taskId);
        if (!task) return res.status(404).json({ message: 'Task not found' });

        task.status = status;
        if (status === 'completed') {
            task.completedAt = new Date();
        } else {
            task.completedAt = undefined;
        }
        await agent.save();

        await logActivity(req.user.clientId, {
            type: 'TEAM',
            status: 'info',
            title: status === 'completed' ? 'Task resolved' : 'Task reopened',
            message: `${req.user.name} updated "${task.title}" for ${agent.name}`,
            metadata: { agentId: agent._id, taskId, status },
        });

        res.json({
            success: true,
            message: status === 'completed' ? 'Task marked resolved' : 'Task reopened',
            pendingTasks: agent.tasks.filter((t) => t.status !== 'completed').length,
        });
    } catch (error) {
        console.error('[TeamAPI] Resolve task error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

// @route   DELETE /api/team/:id
// @desc    Remove a team member
// @access  Private (Admin only)
router.delete('/:id', ...teamAdmin, async (req, res) => {
    try {
        const userToRemove = await User.findById(req.params.id);
        
        if (!userToRemove) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Security: Ensure the admin is deleting a user from their OWN client
        if (userToRemove.clientId !== req.user.clientId) {
            return res.status(403).json({ message: 'Unauthorized to remove this user' });
        }

        // Prevent self-deletion
        if (userToRemove._id.toString() === req.user._id.toString()) {
            return res.status(400).json({ message: 'Cannot remove your own admin account' });
        }

        // 1. Reassign or Unassign active conversations
        await Conversation.updateMany(
            { assignedTo: userToRemove._id },
            { $set: { assignedTo: null, assignedBy: null, assignedAt: null } }
        );

        // 2. Remove the user
        await User.findByIdAndDelete(req.params.id);

        res.json({ success: true, message: 'Team member removed successfully' });
    } catch (error) {
        console.error('[TeamAPI] Remove Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

// @route   PATCH /api/team/:id/hub-access
// @desc    Update assignable dashboard sections for an agent
router.patch('/:id/hub-access', ...teamAdmin, async (req, res) => {
    try {
        const hubAccess = sanitizeHubAccess(req.body?.hubAccess);
        if (!hubAccess.length) {
            return res.status(400).json({ message: 'Select at least one section' });
        }

        const userToUpdate = await User.findById(req.params.id);
        if (!userToUpdate) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (req.user.role !== 'SUPER_ADMIN' && userToUpdate.clientId !== req.user.clientId) {
            return res.status(403).json({ message: 'Unauthorized to modify this user' });
        }

        if (['CLIENT_ADMIN', 'SUPER_ADMIN'].includes(userToUpdate.role)) {
            return res.status(400).json({ message: 'Workspace admins always have full access' });
        }

        userToUpdate.hubAccess = hubAccess;
        await userToUpdate.save();

        res.json({
            success: true,
            message: 'Section access updated',
            user: {
                _id: userToUpdate._id,
                hubAccess: userToUpdate.hubAccess,
            },
        });
    } catch (error) {
        console.error('[TeamAPI] Hub Access Update Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

// @route   PATCH /api/team/:id/role
// @desc    Update a team member's role
// @access  Private (Admin only)
router.patch('/:id/role', ...teamAdmin, async (req, res) => {
    try {
        const { role } = req.body;
        
        if (!['AGENT', 'CLIENT_ADMIN', 'SUPER_ADMIN'].includes(role)) {
            return res.status(400).json({ message: 'Invalid role provided' });
        }

        const userToUpdate = await User.findById(req.params.id);
        
        if (!userToUpdate) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Security: Ensure the admin is modifying a user from their OWN client
        if (req.user.role !== 'SUPER_ADMIN' && userToUpdate.clientId !== req.user.clientId) {
            return res.status(403).json({ message: 'Unauthorized to modify this user' });
        }

        // Prevent self-demotion from admin
        if (userToUpdate._id.toString() === req.user._id.toString() && role !== req.user.role) {
            return res.status(400).json({ message: 'Cannot change your own role' });
        }

        userToUpdate.role = role;
        await userToUpdate.save();

        res.json({ success: true, message: 'Role updated successfully', user: userToUpdate });
    } catch (error) {
        console.error('[TeamAPI] Role Update Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

// @route   GET /api/team/:clientId/performance-stats
// @desc    Get detailed performance metrics for agents
// @access  Private (Admin only)
router.get('/:clientId/performance-stats', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId || clientId !== req.params.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // Calculate Average Response Time (FRT)
        const frtStats = await Conversation.aggregate([
            { $match: { 
                clientId, 
                firstInboundAt: { $exists: true, $ne: null }, 
                firstResponseAt: { $exists: true, $ne: null },
                firstInboundAt: { $gte: sevenDaysAgo }
            }},
            { $project: {
                responseTime: { $subtract: ["$firstResponseAt", "$firstInboundAt"] }
            }},
            { $group: {
                _id: null,
                avgFRT: { $avg: "$responseTime" },
                count: { $sum: 1 }
            }}
        ]);

        // Calculate Resolution Rate
        const totalConvos = await Conversation.countDocuments({ clientId, createdAt: { $gte: sevenDaysAgo } });
        const closedConvos = await Conversation.countDocuments({ clientId, status: 'CLOSED', updatedAt: { $gte: sevenDaysAgo } });

        const avgFRTMillis = frtStats[0]?.avgFRT || 0;
        const avgFRTMinutes = (avgFRTMillis / (1000 * 60)).toFixed(1);

        res.json({
            success: true,
            stats: {
                avgResponseTime: avgFRTMinutes > 0 ? `${avgFRTMinutes}m` : 'Instant',
                resolutionRate: totalConvos > 0 ? `${((closedConvos / totalConvos) * 100).toFixed(0)}%` : '0%',
                totalHandled: totalConvos,
                dataPoints: frtStats[0]?.count || 0
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Metric sync failed', error: error.message });
    }
});

module.exports = router;
