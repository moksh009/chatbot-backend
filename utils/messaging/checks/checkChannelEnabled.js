function checkChannelEnabled({ client, channel }) {
  const enabled = client?.complianceConfig?.channels?.[channel]?.enabled;
  if (enabled === false) {
    return { pass: false, blockedBy: 'channel_disabled', reason: `${channel}_disabled` };
  }
  return { pass: true };
}

module.exports = { checkChannelEnabled };
