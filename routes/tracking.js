const express = require('express');
const router = express.Router();
const AdLead = require('../models/AdLead');

const PRODUCTS = {
    'prod_3mp': 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp',
    'prod_5mp': 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp',
    '3mp': 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp',
    '5mp': 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'
};

// GET /r/:uid/:productId
router.get('/:uid/:productId', async (req, res) => {
    const { uid, productId } = req.params;
    const targetUrl = PRODUCTS[productId] || 'https://delitechsmarthome.in';
    const io = req.app.get('socketio');

    try {
        // Increment click count
        const lead = await AdLead.findByIdAndUpdate(
            uid,
            { $inc: { linkClicks: 1 }, lastInteraction: new Date() },
            { new: true }
        );

        if (lead) {
            console.log(`Link clicked by ${lead.phoneNumber} for ${productId}`);
            
            // Emit socket event for real-time dashboard update
            if (io) {
                io.to(`client_${lead.clientId}`).emit('stats_update', {
                    type: 'link_click',
                    leadId: lead._id,
                    productId
                });
            }
        }
    } catch (err) {
        console.error('Tracking Error:', err);
    }

    // Redirect user to the actual product page
    res.redirect(targetUrl);
});

module.exports = router;
