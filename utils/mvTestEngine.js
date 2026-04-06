"use strict";

/**
 * mvTestEngine.js — Phase 26 Track 5
 * Multivariate A/B test cell generator + chi-square significance calculator.
 */

/**
 * Generate all permutation cells from a list of variables.
 * Each variable has an id + array of options (each with id + value).
 *
 * @param {Array} variables - [{ id, name, options: [{ id, label, value }] }]
 * @returns {Array} cells   - [{ id, variableValues, splitPercent, ... }]
 */
function generateMVCells(variables) {
  if (!variables || variables.length === 0) return [];

  // Cartesian product
  let cells = [{}];
  for (const variable of variables) {
    if (!variable.options || variable.options.length === 0) continue;
    const expanded = [];
    for (const existing of cells) {
      for (const option of variable.options) {
        expanded.push({
          ...existing,
          [variable.id]:           option.id,    // e.g. message: "option_a"
          [`${variable.id}_value`]: option.value  // e.g. message_value: { body: "..." }
        });
      }
    }
    cells = expanded;
  }

  if (cells.length === 0 || (cells.length === 1 && Object.keys(cells[0]).length === 0)) {
    return [];
  }

  const splitPercent = Math.floor(100 / cells.length);
  const remainder    = 100 - (splitPercent * cells.length);

  return cells.map((cellVars, i) => ({
    id:              `cell_${i + 1}`,
    variableValues:  cellVars,
    // Give remainder % to last cell so total always = 100
    splitPercent:    i === cells.length - 1 ? splitPercent + remainder : splitPercent,
    recipientCount:  0,
    sentCount:       0,
    readCount:       0,
    repliedCount:    0,
    replyRate:       0
  }));
}

/**
 * Chi-square test for statistical significance between two cells.
 * Uses 1 degree of freedom (binary outcome: replied / not replied).
 *
 * @param {Object} cellA - { sentCount, repliedCount }
 * @param {Object} cellB - { sentCount, repliedCount }
 * @returns {number}     - Confidence percentage: 0, 90, 95, 99, or 99.9
 */
function calculateSignificance(cellA, cellB) {
  const minRequired = 30;
  if ((cellA.sentCount || 0) < minRequired || (cellB.sentCount || 0) < minRequired) {
    return 0; // not enough data
  }

  const rateA = (cellA.repliedCount || 0) / cellA.sentCount;
  const rateB = (cellB.repliedCount || 0) / cellB.sentCount;

  const totalReplied = (cellA.repliedCount || 0) + (cellB.repliedCount || 0);
  const totalSent    = cellA.sentCount + cellB.sentCount;
  const pooled       = totalSent > 0 ? totalReplied / totalSent : 0;

  if (pooled === 0 || pooled === 1) return 0;

  const expA = cellA.sentCount * pooled;
  const expB = cellB.sentCount * pooled;

  // Chi-square statistic
  const chi2 =
    (Math.pow((cellA.repliedCount || 0) - expA, 2) / expA) +
    (Math.pow((cellB.repliedCount || 0) - expB, 2) / expB);

  // Critical values for 1 df
  if (chi2 > 10.83) return 99.9;
  if (chi2 > 6.63)  return 99;
  if (chi2 > 3.84)  return 95;
  if (chi2 > 2.71)  return 90;
  return Math.round(chi2 * 25);
}

/**
 * Find the winning cell with significance level, comparing all cells against each other.
 * @param {Array}  cells             - Array of cell objects with sentCount, repliedCount
 * @param {number} requiredConfidence - e.g. 95 (default)
 * @returns {{ winnerId, significanceVsSecond, confident }} 
 */
function findMVWinner(cells, requiredConfidence = 95) {
  if (!cells || cells.length < 2) return { winnerId: null, confident: false };

  // Sort by reply rate descending
  const sorted = [...cells]
    .filter(c => c.sentCount > 0)
    .map(c => ({ ...c, replyRate: (c.repliedCount || 0) / c.sentCount }))
    .sort((a, b) => b.replyRate - a.replyRate);

  if (sorted.length < 2) return { winnerId: sorted[0]?.id || null, confident: false };

  const winner = sorted[0];
  const second = sorted[1];
  const sig    = calculateSignificance(winner, second);

  return {
    winnerId:             winner.id,
    winnerReplyRate:      winner.replyRate,
    secondReplyRate:      second.replyRate,
    significanceVsSecond: sig,
    confident:            sig >= requiredConfidence
  };
}

module.exports = { generateMVCells, calculateSignificance, findMVWinner };
