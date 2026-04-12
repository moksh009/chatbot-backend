const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Client = require('../models/Client');
const Conversation = require('../models/Conversation');
const Task = require('../models/Task');
const { protect } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLogger');
const crypto = require('crypto');
const { sendTeamInviteEmail, sendAdminConfirmationEmail } = require('../utils/emailService');
const { checkLimit, incrementUsage } = require('../utils/planLimits');

// @route   GET /api/team
// @route   GET /api/team/:clientId
// @desc    Get all team members for a client with performance metrics
// @access  Private
router.get('/:clientId', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        console.log(`[TeamAPI] Fetching team for explicitly provided clientId: ${clientId}`);

        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
           console.warn(`[TeamAPI] Unauthorized access attempt: ${req.user.clientId} tried to access ${clientId}`);
           return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        // 1. Fetch all users for this client
        const users = await User.find({ clientId }).select('-password');

        // 2. Fetch conversation assignment metrics for these users
        const performanceMetrics = await Conversation.aggregate([
            { $match: { clientId, assignedTo: { $exists: true, $ne: null } } },
            { $group: {
                _id: "$assignedTo",
                totalAssigned: { $sum: 1 },
                resolvedCount: { $sum: { $cond: [{ $eq: ["$status", "CLOSED"] }, 1, 0] } },
                avgCsat: { $avg: "$csatScore.rating" },
                lastActive: { $max: "$lastInteraction" }
            }}
        ]);

        // Map metrics back to users
        const teamWithMetrics = users.map(user => {
            const metric = performanceMetrics.find(m => m._id && m._id.toString() === user._id.toString());
            return {
                ...user.toObject(),
                id: user._id.toString(), // Normalize for frontend
                metrics: {
                    assignedChats: metric ? metric.totalAssigned : 0,
                    resolvedChats: metric ? metric.resolvedCount : 0,
                    avgCsat: metric && metric.avgCsat ? Number(metric.avgCsat.toFixed(1)) : 0,
                    lastActive: metric ? metric.lastActive : null
                }
            };
        });

        res.json({ success: true, team: teamWithMetrics });
    } catch (error) {
        console.error('[TeamAPI] Fetch Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

router.get('/', protect, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        console.log(`[TeamAPI] Fetching team for authenticated user clientId: ${clientId}`);
        
        // REUSE LOGIC: Since we want same logic, we can either extract to helper or just call the same flow
        // To keep it simple and avoid massive refactor, I'll just repeat the logic briefly or redirect
        // But for efficiency, I'll just copy the core logic here
        const users = await User.find({ clientId }).select('-password');
        const performanceMetrics = await Conversation.aggregate([
            { $match: { clientId, assignedTo: { $exists: true, $ne: null } } },
            { $group: {
                _id: "$assignedTo",
                totalAssigned: { $sum: 1 },
                resolvedCount: { $sum: { $cond: [{ $eq: ["$status", "CLOSED"] }, 1, 0] } },
                avgCsat: { $avg: "$csatScore.rating" },
                lastActive: { $max: "$lastInteraction" }
            }}
        ]);

        const teamWithMetrics = users.map(user => {
            const metric = performanceMetrics.find(m => m._id && m._id.toString() === user._id.toString());
            return {
                ...user.toObject(),
                id: user._id.toString(),
                metrics: {
                    assignedChats: metric ? metric.totalAssigned : 0,
                    resolvedChats: metric ? metric.resolvedCount : 0,
                    avgCsat: metric && metric.avgCsat ? Number(metric.avgCsat.toFixed(1)) : 0,
                    lastActive: metric ? metric.lastActive : null
                }
            };
        });

        res.json({ success: true, team: teamWithMetrics });
    } catch (error) {
        console.error('[TeamAPI] Root Fetch Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

// @route   POST /api/team/invite
// @desc    Invite a new team member (Agent)
// @access  Private (Admin only)
router.post('/invite', protect, async (req, res) => {
    const { name, email } = req.body;

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
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ message: 'Client configuration not found' });

        // --- Phase 23: Track 8 - Billing Enforcement (Agents) ---
        const limitCheck = await checkLimit(client._id, 'agents');
        if (!limitCheck.allowed) {
            return res.status(403).json({ success: false, message: limitCheck.reason });
        }

        // Generate a secure temporary password
        const tempPassword = crypto.randomBytes(4).toString('hex'); // 8 char hex

        // 1. Create the User
        const newUser = await User.create({
            name,
            email,
            password: tempPassword, // Will be hashed by User model pre-save hook
            role: 'AGENT',
            clientId,
            business_type: client.businessType || 'ecommerce'
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

// @route   DELETE /api/team/:id
// @desc    Remove a team member
// @access  Private (Admin only)
router.delete('/:id', protect, async (req, res) => {
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

// @route   GET /api/team/:clientId/performance-stats
// @desc    Get detailed performance metrics for agents
// @access  Private (Admin only)
router.get('/:clientId/performance-stats', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
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

// @route   POST /api/team/:clientId/assign-task
// @desc    Assign a task to a team member
// @access  Private (Admin only)
router.post('/:clientId/assign-task', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        const { agentId, title, description, priority, dueDate, relatedLeadId, relatedOrderId } = req.body;

        if (req.user.role !== 'CLIENT_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
            return res.status(403).json({ message: 'Only admins can assign tasks' });
        }

        const Task = require('../models/Task');
        const newTask = await Task.create({
            clientId,
            agentId,
            title,
            description,
            priority: priority || 'medium',
            dueDate,
            relatedLeadId,
            relatedOrderId,
            assignedBy: req.user._id
        });

        // Pulse Log: Task Assigned
        await logActivity(clientId, {
            type: 'TASK',
            status: 'info',
            title: 'New Task Assigned',
            message: `"${title}" has been assigned.`,
            icon: 'ClipboardList',
            url: `/team`, // Or appropriate hub
            metadata: {
                taskId: newTask._id,
                priority
            }
        });

        res.json({ success: true, task: newTask, message: 'Task assigned successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

// @route   GET /api/team/:clientId/tasks
// @desc    Get tasks for the logged in user or all tasks for admin
// @access  Private
router.get('/:clientId/tasks', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        const Task = require('../models/Task');
        
        let query = { clientId };
        
        // Agents only see their own tasks
        if (req.user.role === 'AGENT') {
            query.agentId = req.user._id;
        }

        const tasks = await Task.find(query).sort({ createdAt: -1 });
        res.json({ success: true, tasks });
    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

// @route   PATCH /api/team/:clientId/tasks/:taskId
// @desc    Update task status
// @access  Private
router.patch('/:clientId/tasks/:taskId', protect, async (req, res) => {
    try {
        const { clientId, taskId } = req.params;
        const { status } = req.body;

        const Task = require('../models/Task');
        const task = await Task.findOne({ _id: taskId, clientId });

        if (!task) return res.status(404).json({ message: 'Task not found' });

        // Authorization: Agent can only update their own task
        if (req.user.role === 'AGENT' && task.agentId.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Unauthorized' });
        }

        task.status = status;
        if (status === 'completed') {
            task.completedAt = new Date();
        }

        await task.save();
        res.json({ success: true, task });
    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

module.exports = router;
