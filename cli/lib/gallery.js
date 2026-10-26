// The Sogni community gallery's rules for a listing, mirrored from worlds.sogni.ai so a link the Kit prints is one
// the gallery takes: server/src/dtos/world-submission.dto.ts (SubmitKitWorldDto), server/src/utils/external-world.ts
// (externalWorldUrl) and server/src/service/world-submission.service.ts (submitKit). Keep them in step by hand.
import { isIP } from 'node:net';

/** The longest value the gallery takes, field by field. */
export const LIMITS = Object.freeze({ title: 120, description: 1000, creatorName: 80, url: 2048, coverUrl: 2048 });

/**
 * A length as the gallery measures it (class-validator's MaxLength, through validator.js isLength): an emoji, or a
 * character with its text or emoji variation selector, counts once.
 */
export const galleryLength = text => text.length - (text.match(/[^️︎][️︎]/g) ?? []).length
  - (text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) ?? []).length;

/** Why the gallery would refuse this as a world's link or its cover, or null when it takes it. */
export function linkProblem(value) {
  let url;
  try { url = new URL(value); } catch { return 'is not a link'; }
  if (url.protocol !== 'https:') return 'is not an HTTPS link';
  if (url.username || url.password) return 'has a name or password in it';
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) return `is an IP address (${url.hostname}), not a public name`;
  if (/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) return `is on ${url.hostname}, which is not a public name (localhost, .local, .internal, .test and .invalid never are)`;
  if (!url.hostname.includes('.')) return `has no public name (${url.hostname})`;
  return null;
}

const plural = n => n.toLocaleString('en-US');

/**
 * What the gallery would refuse in the text of a prefilled listing (`fields` are the form's query values): one
 * { field, problem } per field. A field left out, or an empty description or credit, is the person's to type in.
 */
export function galleryIssues(fields) {
  const issues = [];
  for (const field of ['title', 'description', 'creatorName', 'url', 'coverUrl']) {
    const value = fields[field];
    if (value === undefined || (value === '' && field !== 'title')) continue;
    const length = galleryLength(value);
    if (length > LIMITS[field]) issues.push({ field, problem: `is ${plural(length)} characters; the gallery takes at most ${plural(LIMITS[field])}` });
    else if ((field === 'title' || field === 'creatorName') && !value.trim()) issues.push({ field, problem: 'is blank' });
    else if (field === 'url' || field === 'coverUrl') {
      const problem = linkProblem(value);
      if (problem) issues.push({ field, problem });
    }
  }
  return issues;
}
