#!/usr/bin/env node
// mixelparse-watcher.js — v3
// Watches inventory files + EQ log for faction changes + con-based faction detection
// Sends updates to MixelParse over WebSocket on port 27182
//
// Usage: node mixelparse-watcher.js
// Requires: npm install chokidar ws

'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const chokidar = require('chokidar');
const { WebSocketServer } = require('ws');

// ── Log to file (next to exe) so startup output can be reviewed ─────────────
const _logPath = path.join(__dirname, 'mixelparse-watcher.log');
const _logFile = fs.createWriteStream(_logPath, { flags: 'w' });
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...a) => { const s = a.join(' '); _origLog(s); _logFile.write(s + '\n'); };
console.error = (...a) => { const s = a.join(' '); _origErr(s); _logFile.write('[ERR] ' + s + '\n'); };

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  WS_PORT:      27182,
  WS_SECRET:    'mixelparse-inv-v1',
  PING_INTERVAL_MS: 20000,
  // Inventory files — adjust to your EQ folder
  INV_DIR:  'C:\\Program Files (x86)\\Sony\\EverQuest',
  INV_GLOB: '**/*-Inventory.txt',
  // EQ log files — separate Logs subfolder
  LOG_DIR:  'C:\\Program Files (x86)\\Sony\\EverQuest\\Logs',
  LOG_GLOB: 'eqlog_*_P1999Green.txt',
  // Only scan logs for these characters (derived from inventory filenames on startup)
  // Leave empty to auto-detect from inventory files
  MY_CHARS: [],
  // EQ notes file — written by /note command, used for TOD triggers
  NOTES_FILE: 'C:\\Program Files (x86)\\Sony\\EverQuest\\notes.txt',
};

// ── Faction level definitions (P1999 wiki numeric ranges) ───────────────────
// Scowls = Ready to Attack in EQ log text
const FACTION_LEVELS = [
  { name: 'Ally',             min:  1051, max:  2000 },
  { name: 'Warmly',           min:   701, max:  1050 },
  { name: 'Kindly',           min:   451, max:   700 },
  { name: 'Amiable',          min:    51, max:   450 },
  { name: 'Indifferent',      min:   -49, max:    50 },
  { name: 'Apprehensive',     min:  -449, max:   -50 },
  { name: 'Dubious',          min:  -699, max:  -450 },
  { name: 'Threatening',      min: -1049, max:  -700 },
  { name: 'Ready to Attack',  min: -2000, max: -1050 },
];

// Midpoints for each level (used when nudging from unknown baseline)
const LEVEL_MIDPOINTS = {
  'Ally':            1500,
  'Warmly':           875,
  'Kindly':           575,
  'Amiable':          250,
  'Indifferent':        0,
  'Apprehensive':    -250,
  'Dubious':         -575,
  'Threatening':     -875,
  'Ready to Attack': -1500,
};

// Hard floor/ceiling anchor values
const FACTION_MAX = 2000;  // "could not possibly get any better"
const FACTION_MIN = -2000; // "could not possibly get any worse"

// Per-faction nudge (used as fallback when exact mob not in KILL_FACTION_MAP)
// Values are conservative estimates based on typical mobs for that faction.
const FACTION_NUDGE_MAP = {
  'ClawsofVeeshan':     5,   // typical CoV mob ~5 (trash varies 1-15)
  'Kromzek':           10,   // typical Kael storm giant
  'Kromrif':           10,   // typical Kael frost giant
  'KingTormax':        25,   // named giants
  'DainFrostreaverIV': 10,
  'Coldain':            5,
  'RingofScale':        5,
  'Yelinak':            5,
  'GuardiansofVeeshan': 5,
  'StormGuard':         5,
  'EmeraldWarriors':    5,
  'LegionofCabilis':    5,
  "BroodofDi'Zok":      5,
  'SarnakCollective':   5,
  'VenrilSathir':      10,
  'MinionsofScale':     5,
  'DenizensofFear':     5,
  'InhabitantsofHate':  5,
};
const FACTION_NUDGE_DEFAULT = 5; // fallback if faction not in map

// ── Exact per-mob CoV faction gains (sourced from P99 wiki) ─────────────────
// Key: mob name lowercase (as it appears in "X has been slain" log line)
// Value: { ClawsofVeeshan: N, Kromrif: N, Kromzek: N, KingTormax: N, ... }
// Only factions with non-zero changes are listed per mob.
// Raise CoV mobs (killing grants +CoV):
const KILL_FACTION_MAP = {
  // ── Eastern Wastes frost giants (+1 CoV each) ────────────────────────────
  'a frost giant':               { ClawsofVeeshan: 1,  Coldain: 5,  Kromrif: -10, Kromzek: -2  },
  'a frost giant berserker':     { ClawsofVeeshan: 1,  Coldain: 5,  Kromrif: -10, Kromzek: -2  },
  'a frost giant elite':         { ClawsofVeeshan: 1,  Coldain: 5,  Kromrif: -10, Kromzek: -2  },
  'a frost giant savage':        { ClawsofVeeshan: 2,  Coldain: 1,  Kromrif: -20, Kromzek: -5  },
  'a frost giant captain':       { ClawsofVeeshan: 3,  Coldain: 3,  Kromrif: -30, Kromzek: -7  },
  'a frost giant scout':         { ClawsofVeeshan: 1,  Coldain: 5,  Kromrif: -10, Kromzek: -2  },
  // ── Kael frost giants (+15 CoV each) ────────────────────────────────────
  'a frost giant commoner':      { ClawsofVeeshan: 15, Coldain: 30, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a frost giant gladiator':     { ClawsofVeeshan: 15, Coldain: 30, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a frost giant trainer':       { ClawsofVeeshan: 15, Coldain: 30, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a frost giant laborer':       { ClawsofVeeshan: 15, Coldain: 30, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a frost giant sentinel':      { ClawsofVeeshan: 15, Coldain: 30, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a frost giant sentry':        { ClawsofVeeshan: 15, Coldain: 30, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a frost giant berserker':     { ClawsofVeeshan: 15, Coldain: 30, KingTormax: -30, Kromrif: -30, Kromzek: -30 }, // Kael variant overrides EW
  'a Frost Giant Lord':          { ClawsofVeeshan: 15, Coldain: 30, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a frost giant wolf tamer':    { ClawsofVeeshan: 15, Coldain: 30, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  // ── Kael storm giants ───────────────────────────────────────────────────
  'a storm giant commoner':      { ClawsofVeeshan: 5,  KingTormax: -2,  Kromrif: -2,  Kromzek: -10 },
  'a storm giant berserker':     { ClawsofVeeshan: 10, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a storm giant gladiator':     { ClawsofVeeshan: 10, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a storm giant surveyor':      { ClawsofVeeshan: 10, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a Storm Giant Foreman':       { ClawsofVeeshan: 10, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a wounded storm giant':       { ClawsofVeeshan: 10, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  // ── Kael priests/clerics ────────────────────────────────────────────────
  'a cleric of vallon zek':      { ClawsofVeeshan: 10, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a priest of tallon zek':      { ClawsofVeeshan: 10, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'gkrean prophet of tallon':    { ClawsofVeeshan: 10, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'semkak prophet of vallon':    { ClawsofVeeshan: 10, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  // ── Kael guards / legionnaires / watchers (all ~15 CoV) ─────────────────
  'a guardian of zek':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a protector of zek':          { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'protector of zek':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a temple guardian':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'armor of zek':                { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a lesser storm giant noble':  { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a visiting noble':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'an angry commoner':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a domesticated direwolf':     { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'a drakkel dire wolf':         { ClawsofVeeshan: 15,                  Kromrif: -30, Kromzek: -30 },
  'a kromrif recruiter':         { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'kromriff guardsman':          { ClawsofVeeshan: 15,                  Kromrif: -30, Kromzek: -30 },
  // Legionnaires
  'legionnaire byltor':          { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'legionnaire icebender':       { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'legionnaire renarn':          { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'legionnaire sjeldor':         { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'legionnaire yvedrn':          { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  // Watchers / Watchmen
  'watcher thrensheld':          { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'watcher zedlek':              { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'watchman bexlend':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'watchman erendor':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'watchman gardal':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'watchman njella':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'watchman reglekar':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'watchman sunderthorn':        { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'watchman thyek':              { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'watchman vedravik':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'watchman weyaen':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  // Guards
  'guard blaesek':               { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard fjleed':                { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard fjorlek':               { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard fleshflayer':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard greybeard':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard hallenban':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard khyosr':                { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard kkrean':                { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard ragern':                { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard rolkin':                { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard sjior':                 { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard stonebender':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard ulfhedinn':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'guard vydel':                 { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  // Senior Guards
  'senior guard akurr':          { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'senior guard dhryell':        { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'senior guard eihorn':         { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'senior guard grelden':        { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'senior guard icemead':        { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'senior guard randeil':        { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'senior guard tymul':          { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'senior guard whiteaxe':       { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  // Sergeants / Troopers / Veterans
  'sergeant blestrom':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'sergeant brunfel':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'sergeant fjrak':              { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'sergeant miidenaer':          { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'sergeant tellsren':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'sergeant yggrellnik':         { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'trooper derheim':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'trooper dlemdimor':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'trooper ebonblade':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'trooper gyarll':              { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'trooper jhonev':              { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'trooper khyren':              { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'trooper mjflean':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'trooper nyorll':              { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'trooper relhjorn':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'trooper sardek':              { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'veteran icecaller':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'veteran skeldek':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'veteran surlren':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'veteran yllhaydm':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  // Adjutants
  'adjutant cryyrn':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'adjutant derkan':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'adjutant droggren':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'adjutant frinevrn':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'adjutant hekrandor':          { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'adjutant hoggren':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'adjutant jharll':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'adjutant skjell':             { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'adjutant stormkeeper':        { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'adjutant thyek':              { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  // Named mid-tier
  'sentinel sunderdrake':        { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'lieutenant stormeye':         { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'klaggan iceshard':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'vealok the angry':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'clrakk blackfist':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'bjrakor the cold':            { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'fergul frostsky':             { ClawsofVeeshan: 15,                  Kromrif: -30, Kromzek: -30 },
  'fjloaren icebane':            { ClawsofVeeshan: 15,                  Kromrif: -30, Kromzek: -30 },
  'gorul longshanks':            { ClawsofVeeshan: 15,                  Kromrif: -30, Kromzek: -30 },
  'frostgiant overseer':         { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  'lieutenant krofer':           { ClawsofVeeshan: 15, KingTormax: -30, Kromrif: -30, Kromzek: -30 },
  // ── Named raid mobs ──────────────────────────────────────────────────────
  'derakor the vindicator':      { ClawsofVeeshan: 50,  KingTormax: -25,  Kromrif: -25, Kromzek: -100 },
  'the statue of rallos zek':    { ClawsofVeeshan: 500, KingTormax: -250, Kromrif: -250, Kromzek: -1000 },
  'the avatar of war':           { ClawsofVeeshan: 500, KingTormax: -250, Kromrif: -250, Kromzek: -1000 },
  'zlandicar':                   { ClawsofVeeshan: 50,  RingofScale: 50 }, // DN boss

  // ── Yelinak / Dain Frostreaver IV ─────────────────────────────────────────
  // Raised by killing Kael named giants (KingTormax-faction mobs).
  // Common mobs don't give Yelinak/Dain — only named KingTormax-faction ones do.
  'king tormax':                 { Yelinak: 750, DainFrostreaverIV: 750, KingTormax: -1500, Kromzek: -1500 },
  'dlammaz stormslayer':         { Yelinak: 30,  DainFrostreaverIV: 30,  KingTormax: -60,  Kromzek: -60  },
  'drendar blackblade':          { Yelinak: 30,  DainFrostreaverIV: 30,  KingTormax: -60,  Kromzek: -60  },
  'keldor dek`torek':            { Yelinak: 30,  DainFrostreaverIV: 30,  KingTormax: -60,  Kromzek: -60  },
  'velden dragonbane':           { Yelinak: 30,  DainFrostreaverIV: 30,  KingTormax: -60,  Kromzek: -60  },
  'fjokar frozenshard':          { Yelinak: 30,  DainFrostreaverIV: 30,  KingTormax: -60,  Kromzek: -60  },

  // ── Ring of Scale ─────────────────────────────────────────────────────────
  // Raised primarily by killing Mistmoore/Permafrost mobs (not Velious content).
  // Zlandicar above already handles the main Velious RoS mob.
  // Skyfire named (lower RoS) added for completeness:
  'black scar':                  { RingofScale: -50  }, // Skyfire named — lowers RoS
  'talendor':                    { RingofScale: -50  },
  'gorenaire':                   { RingofScale: -50  },
  'severilous':                  { RingofScale: -50  },
  'faydedar':                    { RingofScale: -50  },

  // ── Coldain ───────────────────────────────────────────────────────────────
  // Raised by killing EW/GD frost giants (already in CoV entries above).
  // Additional Coldain-specific mobs that lower it (killing Thurgadin NPCs):
  // Note: wiki says Thurgadin guards are +1 Kromzek, listed here as Coldain lowering mobs.
  // Players would never intentionally lower Coldain so omitting bulk entries.

  // ── Guardians of Veeshan ──────────────────────────────────────────────────
  // ToV dragons — no separate raise mobs; faction tied to CoV dragons in ToV.
  // These lower GoV when killed:
  'aaryonar':                    { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  'cekenar':                     { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  'dagarn the destroyer':        { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  'eashen of the sky':           { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  'jorlleag':                    { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  'lady mirenilla':              { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  'lady nevederia':              { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  'lord feshlak':                { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  "lord koi'doken":              { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  'lord kreizenn':               { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  'sevalak':                     { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  'telkorenar':                  { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  'lendiniara the keeper':       { GuardiansofVeeshan: -50, ClawsofVeeshan: -50 },
  "vulak'aerr":                  { GuardiansofVeeshan: -500, ClawsofVeeshan: -500 }, // ToV boss

  // ── Wuoshi / Kelorek`Dar / Western Wastes named ───────────────────────────
  'wuoshi':                      { ClawsofVeeshan: -50, Yelinak: -50  },
  "kelorek'dar":                 { ClawsofVeeshan: -50                },
  'klandicar':                   { ClawsofVeeshan: -50                },
  'sontalak':                    { ClawsofVeeshan: -50, Yelinak: -50  },
  'harla dar':                   { ClawsofVeeshan: -50, Yelinak: -50  },
};

function levelFromValue(val) {
  for (const lvl of FACTION_LEVELS) {
    if (val >= lvl.min && val <= lvl.max) return lvl.name;
  }
  if (val > 2000) return 'Ally';
  return 'Ready to Attack';
}


// ── Faction state per character ─────────────────────────────────────────────
// factionState[charName][factionKey] = numeric value
const _stateFile = path.join(__dirname, 'mixelparse-factionstate.json');
let factionState = {};
try {
  factionState = JSON.parse(fs.readFileSync(_stateFile, 'utf8'));
  console.log(`[FACTION] Loaded saved faction state for ${Object.keys(factionState).length} char(s)`);
} catch (e) {
  console.log('[FACTION] No saved faction state found, will build from log scan');
}
let _factionSaveTimer = null;
function saveFactionState() {
  clearTimeout(_factionSaveTimer);
  _factionSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(_stateFile, JSON.stringify(factionState)); } catch (e) {}
  }, 2000);
}

function getFactionValue(charName, factionKey) {
  return (factionState[charName] || {})[factionKey];
}

function setFactionValue(charName, factionKey, val) {
  if (!factionState[charName]) factionState[charName] = {};
  factionState[charName][factionKey] = Math.max(FACTION_MIN, Math.min(FACTION_MAX, val));
  saveFactionState();
}

// ── Zone state per character ────────────────────────────────────────────────
// zoneState[charName] = { zone, timestamp }
const _zoneFile = path.join(__dirname, 'mixelparse-zonestate.json');
let zoneState = {};
try {
  zoneState = JSON.parse(fs.readFileSync(_zoneFile, 'utf8'));
  console.log(`[ZONE] Loaded saved zone state for ${Object.keys(zoneState).length} char(s)`);
} catch (e) {
  console.log('[ZONE] No saved zone state found');
}
let _zoneSaveTimer = null;
function saveZoneState() {
  clearTimeout(_zoneSaveTimer);
  _zoneSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(_zoneFile, JSON.stringify(zoneState)); } catch (e) {}
  }, 2000);
}

const RE_ZONE_ENTER = /^\[.+?\] You have entered (.+?)\./;

function parseZoneLine(charName, line) {
  const m = line.match(RE_ZONE_ENTER);
  if (!m) return null;
  const zone = m[1].trim();
  const timestamp = new Date().toISOString();
  zoneState[charName] = { zone, timestamp };
  saveZoneState();
  return { zone, timestamp };
}

// ── Log faction message patterns ─────────────────────────────────────────────
// "[Day Mon DD HH:MM:SS YYYY] Your faction standing with FactionName got better."
const RE_FACTION = /^\[.+?\] Your faction standing with (\S+) (got better|got worse|could not possibly get any better|could not possibly get any worse)\.?'?$/;

// Con message patterns:
//   "a wyvern regards you as an ally."          (Ally only uses "as an")
//   "Nanzata the Warder regards you warmly."
//   "a frost giant regards you indifferently -- What do you want?"
const RE_CON = /^\[.+?\] (.+?) (?:(?:(?:regards|considers|judges) you|glares at you) (?:as an? )?\w*?\b(ally|warmly|kindly|amiably?|indifferently?|apprehensively?|dubiously?|threateningly?)|(ally|warmly|kindly|amiably?|indifferently?|apprehensively?|dubiously?|threateningly?) (?:regards|considers|judges) you|(scowls) at you)/i;

// Map of NPC name (lowercase, as it appears in EQ log) → faction display name
// Multiple NPCs can map to the same faction — whichever you happen to con updates it.
// Focused on common mobs near zone entrances you'd naturally pass.
const CON_TARGET_MAP = {
  // ── Claws of Veeshan ──────────────────────────────────────────────────────
  'a wyvern':                    'Claws of Veeshan',  // Great Divide / Western Wastes / Velious-wide
  'a velium wyvern':             'Claws of Veeshan',  // Great Divide / Western Wastes
  'nanzata the warder':          'Claws of Veeshan',  // ToV front door named
  'a tov warder':                'Claws of Veeshan',
  'a fiery watcher':             'Claws of Veeshan',
  'a glimmering drake':             'Claws of Veeshan',
  'a wyvern huntress':             'Claws of Veeshan',
  'korakaz':             'Kromzek',
  'priest grenk':             'Kromzek',
  'a storm giant escort':             'Kromzek',
  'esorpa of the ring':             'Ring of Scale',
  'a cerulean sky gazer':             'Claws of Veeshan',
  'a cragwyrm':             'Claws of Veeshan',
  'a dalgortha':             'Claws of Veeshan',
  'a fiery temple guardian':             'Claws of Veeshan',
  'a gargoyle guardian':             'Claws of Veeshan',
  'a glimmer drake':             'Claws of Veeshan',
  'a gravid drake':             'Claws of Veeshan',
  'a hungry cube':             'Claws of Veeshan',
  'a large velium statue':             'Claws of Veeshan',
  'a lava dancer':             'Claws of Veeshan',
  'a shambling cube':             'Claws of Veeshan',
  'a shimmering green drake':             'Claws of Veeshan',
  'a velious drake':             'Claws of Veeshan',
  'aaryonar':             'Claws of Veeshan',
  'abudan fe`dhar':             'Claws of Veeshan',
  'adwetram fe`dhar':             'Claws of Veeshan',
  'ahcaz':             'Claws of Veeshan',
  'an ancient ice wurm defender':             'Claws of Veeshan',
  'an ancient sky drake':             'Claws of Veeshan',
  'an elder onyx drake':             'Claws of Veeshan',
  'an onyx sky drake':             'Claws of Veeshan',
  'arreken skyward':             'Claws of Veeshan',
  'asteinnon fe`dhar':             'Claws of Veeshan',
  'ayillish':             'Claws of Veeshan',
  'azureake':             'Claws of Veeshan',
  'belijor the emerald eye':             'Claws of Veeshan',
  'bezeb':             'Claws of Veeshan',
  'bouncer boulder':             'Claws of Veeshan',
  'bratavar':             'Claws of Veeshan',
  'bufa':             'Claws of Veeshan',
  'cargalia':             'Claws of Veeshan',
  'cekenar':             'Claws of Veeshan',
  'chymot':             'Claws of Veeshan',
  'commander leuz':             'Claws of Veeshan',
  'crendatha fe`dhar':             'Claws of Veeshan',
  'dagarn the destroyer':             'Claws of Veeshan',
  'dalshim fe`dhar':             'Claws of Veeshan',
  'del sapara':             'Claws of Veeshan',
  'deoryn fe`dhar':             'Claws of Veeshan',
  'derasinal':             'Claws of Veeshan',
  'draazak':             'Claws of Veeshan',
  'dygwyn fe`dhar':             'Claws of Veeshan',
  'dyr fe`dhar':             'Claws of Veeshan',
  'eashen of the sky':             'Claws of Veeshan',
  'elaend fe`dhar':             'Claws of Veeshan',
  'elder hajnix':             'Claws of Veeshan',
  'elder kajind':             'Claws of Veeshan',
  'elder kalur':             'Claws of Veeshan',
  'eldriaks fe`dhar':             'Claws of Veeshan',
  'elyshum fe`dhar':             'Claws of Veeshan',
  'entariz':             'Claws of Veeshan',
  'fardonad fe`dhar':             'Claws of Veeshan',
  'gafala':             'Claws of Veeshan',
  'gangel':             'Claws of Veeshan',
  'glati':             'Claws of Veeshan',
  'glydoc fe`dhar':             'Claws of Veeshan',
  'gozzrem':             'Claws of Veeshan',
  'grudash the baker':             'Claws of Veeshan',
  'honvar':             'Claws of Veeshan',
  'hytloc':             'Claws of Veeshan',
  'ionat':             'Claws of Veeshan',
  'jaelk':             'Claws of Veeshan',
  'jaled dar`s shade':             'Claws of Veeshan',
  'jaylorx':             'Claws of Veeshan',
  'jen sapara':             'Claws of Veeshan',
  'jendavudd fe`dhar':             'Claws of Veeshan',
  'jorlleag':             'Claws of Veeshan',
  'jualicn':             'Claws of Veeshan',
  'kalacs fe`dhar':             'Claws of Veeshan',
  'kardakor':             'Claws of Veeshan',
  'karkona':             'Claws of Veeshan',
  'kelorek`dar':             'Claws of Veeshan',
  'komawin fe`dhar':             'Claws of Veeshan',
  'lady mirenilla':             'Claws of Veeshan',
  'lady nevederia':             'Claws of Veeshan',
  'laegdric fe`dhar':             'Claws of Veeshan',
  'lararith':             'Claws of Veeshan',
  'lawyla':             'Claws of Veeshan',
  'lendiniara the keeper':             'Claws of Veeshan',
  'lignark':             'Claws of Veeshan',
  'linbrak':             'Claws of Veeshan',
  'lord feshlak':             'Claws of Veeshan',
  'lord koi`doken':             'Claws of Veeshan',
  'lord kreizenn':             'Claws of Veeshan',
  'lord yelinak':             'Claws of Veeshan',
  'lothieder fe`dhar':             'Claws of Veeshan',
  'makala':             'Claws of Veeshan',
  'mazi':             'Claws of Veeshan',
  'medry fe`dhar':             'Claws of Veeshan',
  'morachii fe`dhar':             'Claws of Veeshan',
  'mraaka':             'Claws of Veeshan',
  'myga':             'Claws of Veeshan',
  'nalelin fe`dhar':             'Claws of Veeshan',
  'nalginor fe`dhar':             'Claws of Veeshan',
  'neordla':             'Claws of Veeshan',
  'norsirx':             'Claws of Veeshan',
  'ocoenydd fe`dhar':             'Claws of Veeshan',
  'oct velic':             'Claws of Veeshan',
  'oglard':             'Claws of Veeshan',
  'onava':             'Claws of Veeshan',
  'onerind fe`dhar':             'Claws of Veeshan',
  'orthor velic':             'Claws of Veeshan',
  'pantrilla':             'Claws of Veeshan',
  'placlis':             'Claws of Veeshan',
  'poalgin fe`dhar':             'Claws of Veeshan',
  'qalcnic fe`dhar':             'Claws of Veeshan',
  'quadrix velic':             'Claws of Veeshan',
  'quoza':             'Claws of Veeshan',
  'qynydd fe`dhar':             'Claws of Veeshan',
  'ralgyn':             'Claws of Veeshan',
  'riran fe`dhar':             'Claws of Veeshan',
  'rolandal':             'Claws of Veeshan',
  'salginor':             'Claws of Veeshan',
  'scout charisa':             'Claws of Veeshan',
  'sentry kale':             'Claws of Veeshan',
  'sevalak':             'Claws of Veeshan',
  'suez':             'Claws of Veeshan',
  'taegria fe`dhar':             'Claws of Veeshan',
  'talgixn fe`dhar':             'Claws of Veeshan',
  'talnifs':             'Claws of Veeshan',
  'talon velic':             'Claws of Veeshan',
  'telkorenar':             'Claws of Veeshan',
  'telnaq':             'Claws of Veeshan',
  'tetragon velic':             'Claws of Veeshan',
  'the seer':             'Claws of Veeshan',
  'theldek the stinger':             'Claws of Veeshan',
  'tonvan fe`dhar':             'Claws of Veeshan',
  'tranala':             'Claws of Veeshan',
  'tri velic':             'Claws of Veeshan',
  'tsiraka':             'Claws of Veeshan',
  'tyddyn fe`dhar':             'Claws of Veeshan',
  'ualkic fe`dhar':             'Claws of Veeshan',
  'uiliak':             'Claws of Veeshan',
  'umykith fe`dhar':             'Claws of Veeshan',
  'vellyn fe`dhar':             'Claws of Veeshan',
  'vitaela':             'Claws of Veeshan',
  'vobryn fe`dhar':             'Claws of Veeshan',
  'von':             'Claws of Veeshan',
  'vulak`aerr':             'Claws of Veeshan',
  'yaced':             'Claws of Veeshan',
  'yal':             'Claws of Veeshan',
  'yeldema':             'Claws of Veeshan',
  'yendilor the cerulean wing':             'Claws of Veeshan',
  'yvolcarn':             'Claws of Veeshan',
  'zaldin fe`dhar':             'Claws of Veeshan',
  'zalerez':             'Claws of Veeshan',
  'zemm':             'Claws of Veeshan',
  'ziglark whisperwing':             'Claws of Veeshan',
  'zil sapara':             'Claws of Veeshan',
  'zildainez':             'Claws of Veeshan',
  'zlexak':             'Claws of Veeshan',
  'zynil':             'Claws of Veeshan',  // ToV entrance
  'an emerald sky defender':     'Claws of Veeshan',  // Temple of Veeshan
  'a guardian of the temple':    'Claws of Veeshan',  // Temple of Veeshan
  'sontalak':                    'Claws of Veeshan',  // Western Wastes named dragon
  'klandicar':                   'Claws of Veeshan',  // Western Wastes named
  'harla dar':                   'Claws of Veeshan',  // Western Wastes named
  "kelorek'dar":                 'Claws of Veeshan',  // Cobalt Scar named
  'wuoshi':                      'Claws of Veeshan',  // Wakening Land named
  'a crag spider':               'Claws of Veeshan',  // Cobalt Scar — fastest CoV con
  'a cobalt drake':              'Claws of Veeshan',  // Cobalt Scar — fast CoV con
  'a velium drake':              'Claws of Veeshan',  // Western Wastes common
  'a western wastes dragon':     'Claws of Veeshan',  // WW generic
  'a dragon':                    'Claws of Veeshan',  // ToV interior generic
  // ── Guardians of Veeshan ──────────────────────────────────────────────────
  'a guardian of veeshan':       'Guardians of Veeshan',
  // ── Ring of Scale ─────────────────────────────────────────────────────────
  'a dragonkin':                 'Ring of Scale',     // Overthere / Burning Woods
  'a ring of scale':             'Ring of Scale',     // Burning Woods
  'a blackscale':                'Ring of Scale',     // Burning Woods
  'a silvered dragon':           'Ring of Scale',     // Burning Woods named
  // ── Yelinak ───────────────────────────────────────────────────────────────
  'a skyshrine guard':           'Yelinak',           // Skyshrine entrance
  'a drachnid':                  'Yelinak',           // Skyshrine interior
  'a drachnid soldier':          'Yelinak',           // Skyshrine
  'a drachnid silkweaver':       'Yelinak',           // Skyshrine
  'a drachnid worker':           'Yelinak',           // Skyshrine
  'a drolvarg':                  'Yelinak',           // Skyshrine
  // ── Kromzek ───────────────────────────────────────────────────────────────
  'a frost giant':               'Kromzek',
  'a frost giant berserker':     'Kromzek',
  'a frost giant elite':         'Kromzek',
  'a frost giant scout':         'Kromzek',
  'a frost giant commoner':      'Kromzek',
  'a frost giant gladiator':     'Kromzek',
  'a frost giant trainer':       'Kromzek',
  'a frost giant laborer':       'Kromzek',
  'a frost giant sentinel':      'Kromzek',
  'a frost giant sentry':        'Kromzek',
  'a frost giant wolf tamer':    'Kromzek',
  'a frost giant lord':          'Kromzek',
  'a storm giant commoner':      'Kromzek',
  'a storm giant berserker':     'Kromzek',
  'a storm giant gladiator':     'Kromzek',
  'a storm giant surveyor':      'Kromzek',
  'a storm giant foreman':       'Kromzek',
  'a wounded storm giant':       'Kromzek',
  'a lesser storm giant noble':  'Kromzek',
  'a visiting noble':            'Kromzek',
  'an angry commoner':           'Kromzek',
  'a domesticated direwolf':     'Kromzek',
  'a guardian of zek':           'Kromzek',
  'a protector of zek':          'Kromzek',
  'protector of zek':            'Kromzek',
  'a temple guardian':           'Kromzek',
  'armor of zek':                'Kromzek',
  'a kromzek guard':             'Kromzek',
  'a giant warrior':             'Kromzek',
  'a cleric of vallon zek':      'Kromzek',
  'a priest of tallon zek':      'Kromzek',
  'gkrean prophet of tallon':    'Kromzek',
  'semkak prophet of vallon':    'Kromzek',
  'a kromrif recruiter':         'Kromzek',
  'legionnaire byltor':          'Kromzek',
  'legionnaire icebender':       'Kromzek',
  'legionnaire renarn':          'Kromzek',
  'legionnaire sjeldor':         'Kromzek',
  'legionnaire yvedrn':          'Kromzek',
  'watcher thrensheld':          'Kromzek',
  'watcher zedlek':              'Kromzek',
  'watchman bexlend':            'Kromzek',
  'watchman erendor':            'Kromzek',
  'watchman gardal':             'Kromzek',
  'watchman njella':             'Kromzek',
  'watchman reglekar':           'Kromzek',
  'watchman sunderthorn':        'Kromzek',
  'watchman thyek':              'Kromzek',
  'watchman vedravik':           'Kromzek',
  'watchman weyaen':             'Kromzek',
  'guard blaesek':               'Kromzek',
  'guard fjleed':                'Kromzek',
  'guard fjorlek':               'Kromzek',
  'guard fleshflayer':           'Kromzek',
  'guard greybeard':             'Kromzek',
  'guard hallenban':             'Kromzek',
  'guard khyosr':                'Kromzek',
  'guard kkrean':                'Kromzek',
  'guard ragern':                'Kromzek',
  'guard rolkin':                'Kromzek',
  'guard sjior':                 'Kromzek',
  'guard stonebender':           'Kromzek',
  'guard ulfhedinn':             'Kromzek',
  'guard vydel':                 'Kromzek',
  'senior guard akurr':          'Kromzek',
  'senior guard dhryell':        'Kromzek',
  'senior guard eihorn':         'Kromzek',
  'senior guard grelden':        'Kromzek',
  'senior guard icemead':        'Kromzek',
  'senior guard randeil':        'Kromzek',
  'senior guard tymul':          'Kromzek',
  'senior guard whiteaxe':       'Kromzek',
  'sergeant blestrom':           'Kromzek',
  'sergeant brunfel':            'Kromzek',
  'sergeant fjrak':              'Kromzek',
  'sergeant miidenaer':          'Kromzek',
  'sergeant tellsren':           'Kromzek',
  'sergeant yggrellnik':         'Kromzek',
  'trooper derheim':             'Kromzek',
  'trooper dlemdimor':           'Kromzek',
  'trooper ebonblade':           'Kromzek',
  'trooper gyarll':              'Kromzek',
  'trooper jhonev':              'Kromzek',
  'trooper khyren':              'Kromzek',
  'trooper mjflean':             'Kromzek',
  'trooper nyorll':              'Kromzek',
  'trooper relhjorn':            'Kromzek',
  'trooper sardek':              'Kromzek',
  'veteran icecaller':           'Kromzek',
  'veteran skeldek':             'Kromzek',
  'veteran surlren':             'Kromzek',
  'veteran yllhaydm':            'Kromzek',
  'adjutant cryyrn':             'Kromzek',
  'adjutant derkan':             'Kromzek',
  'adjutant droggren':           'Kromzek',
  'adjutant frinevrn':           'Kromzek',
  'adjutant hekrandor':          'Kromzek',
  'adjutant hoggren':            'Kromzek',
  'adjutant jharll':             'Kromzek',
  'adjutant skjell':             'Kromzek',
  'adjutant stormkeeper':        'Kromzek',
  'adjutant thyek':              'Kromzek',
  'sentinel sunderdrake':        'Kromzek',
  'lieutenant stormeye':         'Kromzek',
  'klaggan iceshard':            'Kromzek',
  'vealok the angry':            'Kromzek',
  'clrakk blackfist':            'Kromzek',
  'bjrakor the cold':            'Kromzek',
  'frostgiant overseer':         'Kromzek',
  'lieutenant krofer':           'Kromzek',
  'derakor the vindicator':      'Kromzek',
  // ── Kromrif ───────────────────────────────────────────────────────────────
  'a frost giant warrior':       'Kromrif',
  'a kromrif':                   'Kromrif',
  'a frost giant savage':        'Kromrif',
  'a frost giant captain':       'Kromrif',
  'fergul frostsky':             'Kromrif',
  'fjloaren icebane':            'Kromrif',
  'gorul longshanks':            'Kromrif',
  'kromriff guardsman':          'Kromrif',
  'a drakkel dire wolf':         'Kromrif',
  // ── Coldain ───────────────────────────────────────────────────────────────
  'a coldain guard':             'Coldain',           // Thurgadin entrance
  'a coldain':                   'Coldain',
  'a coldain warrior':           'Coldain',
  'a coldain soldier':           'Coldain',
  'a coldain miner':             'Coldain',
  'a coldain scout':             'Coldain',
  'a coldain citizen':           'Coldain',
  'a coldain defender':          'Coldain',
  'a coldain champion':          'Coldain',
  'tain hammerfrost':            'Coldain',           // Thurgadin npc
  // ── Dain Frostreaver IV ───────────────────────────────────────────────────
  'dain frostreaver iv':         'Dain Frostreaver IV',
  // ── King Tormax ───────────────────────────────────────────────────────────
  'king tormax':                 'King Tormax',
  'dlammaz stormslayer':         'King Tormax',
  'drendar blackblade':          'King Tormax',
  "keldor dek'torek":            'King Tormax',
  'velden dragonbane':           'King Tormax',
  // ── Storm Guards (Thurgadin) ──────────────────────────────────────────────
  'a storm guard':               'Storm Guards',      // Thurgadin — easiest city con
  'a storm guard captain':       'Storm Guards',
  'a storm guard lieutenant':    'Storm Guards',
  'a storm guard officer':       'Storm Guards',
  'a storm guard sergeant':      'Storm Guards',
  // ── Emerald Warriors (Skyshrine) ──────────────────────────────────────────
  'an emerald warrior':          'Emerald Warriors',  // Skyshrine city
  'an emerald warrior guard':    'Emerald Warriors',
  // ── Kael Drakkel ──────────────────────────────────────────────────────────
  'a kael guard':                'Kael Drakkel',      // Kael city entrance
  'a kael gladiator':            'Kael Drakkel',
  'a kael warrior':              'Kael Drakkel',
  'a kael citizen':              'Kael Drakkel',
  'a kael berserker':            'Kael Drakkel',
  'a kael champion':             'Kael Drakkel',
  'a kael dragoon':              'Kael Drakkel',
  'a kael soldier':              'Kael Drakkel',
  'a kael noble':                'Kael Drakkel',
  'a kael priest':               'Kael Drakkel',
  'a kael shaman':               'Kael Drakkel',
  'a kael wizard':               'Kael Drakkel',
  'a frost giant elder':         'Kael Drakkel',
  'a frost giant cleric':        'Kael Drakkel',
  'a frost giant paladin':       'Kael Drakkel',
  'a frost giant necromancer':   'Kael Drakkel',
  'an avatar of war':            'Kael Drakkel',
  // ── Thurgadin ─────────────────────────────────────────────────────────────
  'a thurgadin guard':           'Thurgadin',         // Thurgadin entrance area
  'a thurgadin citizen':         'Thurgadin',
  'a thurgadin soldier':         'Thurgadin',
  'a thurgadin champion':        'Thurgadin',
  'a thurgadin champion guard':  'Thurgadin',
  'a coldain blacksmith':        'Thurgadin',
  'a coldain jeweler':           'Thurgadin',
  'a coldain merchant':          'Thurgadin',
  'a coldain brewer':            'Thurgadin',
  // ── Skyshrine (Yelinak faction — covers Skyshrine city npcs specifically) ─
  // Note: Yelinak faction = non-Veeshan city faction in Skyshrine
  // Dragons inside Skyshrine already handled above under Yelinak
  // ── Legion of Cabilis ─────────────────────────────────────────────────────
  'an iksar guard':              'Legion of Cabilis',
  'a scaled wolf':               'Legion of Cabilis',
  'an iksar warrior':            'Legion of Cabilis',
  'an iksar citizen':            'Legion of Cabilis',
  'a cabilis guard':             'Legion of Cabilis',
  // ── Brood of Di'Zok ───────────────────────────────────────────────────────
  "a di'zok guard":              "Brood of Di'Zok",   // Chardok entrance
  "a di'zok crusader":           "Brood of Di'Zok",
  "a di'zok duelist":            "Brood of Di'Zok",
  "a di'zok soldier":            "Brood of Di'Zok",
  "a di'zok knight":             "Brood of Di'Zok",
  "a di'zok advisor":            "Brood of Di'Zok",
  "di'zok crusader":             "Brood of Di'Zok",
  'an off duty slavemaster':     "Brood of Di'Zok",
  "a di`zok underling":          "Brood of Di'Zok",
  // ── Sarnak Collective ─────────────────────────────────────────────────────
  'a sarnak':                    'Sarnak Collective',
  'a sarnak warrior':            'Sarnak Collective',
  'a sarnak berserker':          'Sarnak Collective',
  'a sarnak soldier':            'Sarnak Collective',
  // ── Brood of Kotiz (Iksar unliving — Field of Bone area) ──────────────────
  'a skeleton':                  'Brood of Kotiz',    // Field of Bone
  'a greater skeleton':          'Brood of Kotiz',
  'an undead iksar':             'Brood of Kotiz',
  // ── Venril Sathir ─────────────────────────────────────────────────────────
  'venril sathir':               'Venril Sathir',
  'venril sathir remains':       'Venril Sathir',
  // ── Minions of Scale ──────────────────────────────────────────────────────
  'a dragonscale':               'Minions of Scale',  // Kunark
  // ── Vox / Nagafen ─────────────────────────────────────────────────────────
  'lady vox':                    'Vox',
  'a vox guardian':              'Vox',               // Permafrost guards
  'a vox servant':               'Vox',
  'lord nagafen':                'Nagafen',
  'a nagafen guardian':          'Nagafen',           // Solusek B guards
  // ── Denizens of Fear ──────────────────────────────────────────────────────
  'a shiverback':                'Denizens of Fear',
  'a terror':                    'Denizens of Fear',
  'a dread':                     'Denizens of Fear',
  'a fright':                    'Denizens of Fear',
  'a horror':                    'Denizens of Fear',
  'an enraged dread':            'Denizens of Fear',
  'a cazicite':                  'Denizens of Fear',
  // ── Inhabitants of Hate ───────────────────────────────────────────────────
  'an erudite':                  'Inhabitants of Hate',
  'a cleric of innoruuk':        'Inhabitants of Hate',
  'a heretic':                   'Inhabitants of Hate',
  'a shadow knight':             'Inhabitants of Hate',
  'a paladin of innoruuk':       'Inhabitants of Hate',
  'innoruuk':                    'Inhabitants of Hate',
  // ── Guards of Qeynos ──────────────────────────────────────────────────────
  'a qeynos guard':              'Guards of Qeynos',
  'a guard':                     'Guards of Qeynos',  // North/South Qeynos
  // ── The Dead (Neriak) — needed for Thex Mallet ────────────────────────────
  'a crusader of greenmist':     'The Dead',          // Neriak Third Gate
  'a dark elf crusader':         'The Dead',
  'a dark elf guard':            'The Dead',          // Neriak
  'a necromancer':               'The Dead',          // Neriak necro guards
};

// Map con standing word (lowercase, from log) → FACTION_LEVELS name
const CON_WORD_TO_LEVEL = {
  'ally':           'Ally',
  'warmly':         'Warmly',
  'kindly':         'Kindly',
  'amiable':        'Amiable',
  'amiably':        'Amiable',
  'indifferent':    'Indifferent',
  'indifferently':  'Indifferent',
  'apprehensive':   'Apprehensive',
  'apprehensively': 'Apprehensive',
  'dubious':        'Dubious',
  'dubiously':      'Dubious',
  'threatening':    'Threatening',
  'threateningly':  'Threatening',
  'scowls':         'Ready to Attack',
};

function parseConLine(charName, line) {
  const m = line.match(RE_CON);
  if (!m) return null;

  const npcName = m[1].toLowerCase();
  const conWord = (m[2] || m[3] || m[4]).toLowerCase();

  const displayName = CON_TARGET_MAP[npcName];
  if (!displayName) return null; // NPC not in our table

  const levelName = CON_WORD_TO_LEVEL[conWord];
  if (!levelName) return null;

  // Con gives us exact level — snap value to midpoint of that level's range
  const newVal = LEVEL_MIDPOINTS[levelName];

  // Find the log key for this faction display name (reverse lookup)
  const logKey = Object.entries(TRACKED_FACTIONS).find(([,v]) => v === displayName)?.[0] || displayName;
  setFactionValue(charName, logKey, newVal);

  return { logKey, displayName, value: newVal, level: levelName, source: 'con' };
}

// ── Slain-line kill detection ────────────────────────────────────────────────
// "[Day Mon DD HH:MM:SS YYYY] Mob Name has been slain by Player!"
// "[Day Mon DD HH:MM:SS YYYY] You have slain Mob Name!"
const RE_SLAIN_BY   = /^\[.+?\] (.+?) has been slain by /i;
const RE_YOU_SLAIN  = /^\[.+?\] You have slain (.+?)!/i;

// ── Session tracker regexes ──────────────────────────────────────────────────
const RE_SESSION_LOGIN  = /Welcome to EverQuest!/;
const RE_SESSION_XP     = /You gain (?:party )?experience!!/;
const RE_SESSION_LOOT   = /--You have looted (?:a |an )?(.+?)\.--/i;
const RE_SESSION_VENDOR = /\] You receive (.+?) from .+? for the .+?\(s\)\./;
const RE_SESSION_COIN   = /\] You receive (.+?) from the corpse\./;
const RE_SESSION_CAMP   = /It will take you about 30 seconds to prepare your camp\./;

// ── Charm-kill tracking (Enchanter/pet-class charmed-pet kills) ───────────────
// On P99 there is NO charm-landing log line.  The only signal is the cast line.
// Strategy: when a charm spell is cast, set a per-character flag with a 15-min
// TTL.  Any RE_SLAIN_BY kill (mob killed by a third party) while the flag is
// active is credited to the session as a charmed-pet kill.
// Full ENC charm line for P99 Velious:
//   Charm (L12) · Beguile (L24) · Cajoling Whispers (L39) · Allure (L49) ·
//   Boltran's Agacerie (L53 Kun) · Dictate (L60 Kun)
const CHARM_SPELL_NAMES = new Set([
  'Charm', 'Beguile', 'Cajoling Whispers', 'Allure',
  "Boltran's Agacerie", 'Dictate'
]);
const RE_CHARM_CAST    = /^\[.+?\] You begin casting (.+?)\./;
const RE_SLAIN_BY_FULL = /^\[.+?\] (.+?) has been slain by (.+?)!/i;
const RE_PET_ATTACK    = /^\[.+?\] (.+?) says?,? '?Attacking (.+?) Master\.?'?/i;
const RE_LOC           = /Your Location is ([\d.-]+),\s*([\d.-]+),\s*([\d.-]+)/;
const RE_CHARM_BROKE   = /Your charm spell has worn off\./;
const CHARM_TTL_MS     = 15 * 60 * 1000;   // 15 min — charm never lasts this long
const CHARM_CONFIRM_MS = 5 * 1000;          // XP must arrive within 5s of slain line
const _charmLastCast   = {};                // { [charName]: timestamp }
const _pendingCharmKill = {};               // { [charName]: { mob, ts } } — awaiting XP confirm
const _lastLocByChar   = {};               // { [charName]: { x, y, z } }
const _activePetByChar = {};               // { [charName]: { petType, loc } }
const _charmBrokeByChar= {};               // { [charName]: boolean }

function parseSlainLine(charName, line) {
  let mobName = null;
  const m1 = line.match(RE_SLAIN_BY);
  const m2 = line.match(RE_YOU_SLAIN);
  if (m1) mobName = m1[1].trim().toLowerCase();
  else if (m2) mobName = m2[1].trim().toLowerCase();
  if (!mobName) return null;

  const factionChanges = KILL_FACTION_MAP[mobName];
  if (!factionChanges) return null; // mob not tracked

  const results = [];
  for (const [logKey, delta] of Object.entries(factionChanges)) {
    const displayName = TRACKED_FACTIONS[logKey] || logKey;
    const currentVal = getFactionValue(charName, logKey) ?? 0;
    const newVal = Math.max(FACTION_MIN, Math.min(FACTION_MAX, currentVal + delta));
    setFactionValue(charName, logKey, newVal);
    const levelName = levelFromValue(newVal);
    results.push({ logKey, displayName, value: newVal, level: levelName, source: 'kill', delta });
  }
  return results.length ? results : null;
}

// Factions to track — log key (no spaces) → display name
// Expanded from FACTION_LIST in index.html + top factions from log analysis
const TRACKED_FACTIONS = {
  // Velious raid
  'ClawsofVeeshan':       'Claws of Veeshan',
  'RingofScale':          'Ring of Scale',
  'Yelinak':              'Yelinak',
  'Kromzek':              'Kromzek',
  'Kromrif':              'Kromrif',
  'Coldain':              'Coldain',
  'KingTormax':           'King Tormax',
  'DainFrostreaverIV':    'Dain Frostreaver IV',
  'GuardiansofVeeshan':   'Guardians of Veeshan',
  // Velious city
  'StormGuard':           'Storm Guards',
  'EmeraldWarriors':      'Emerald Warriors',
  'KaelDrakkel':          'Kael Drakkel',
  'Thurgadin':            'Thurgadin',
  'Skyshrine':            'Skyshrine',
  // Kunark
  'LegionofCabilis':      'Legion of Cabilis',
  'BroodofDi`Zok':        'Brood of Di\'Zok',
  'SarnakCollective':     'Sarnak Collective',
  'BroodofKotiz':         'Brood of Kotiz',
  'VenrilSathir':         'Venril Sathir',
  'FirionaVie':           'Firiona Vie',
  'BurynaiLegion':        'Burynai Legion',
  'MinionsofScale':       'Minions of Scale',
  'SwiftTails':           'Swift Tails',
  'TheDead':              'The Dead',
  // Antonica
  'GuardiansoftheVale':   'Guardians of the Vale',
  'FaydarksChampions':    'Faydark\'s Champions',
  'IndigoBrotherhood':    'Indigo Brotherhood',
  'CrushboneOrcs':        'Crushbone Orcs',
  'GuardsofQeynos':       'Guards of Qeynos',
  'KnightsofTruth':       'Knights of Truth',
  'AshenOrder':           'Ashen Order',
  'CommonsResidents':     'Commons Residents',
  'DeathfistOrcs':        'Deathfist Orcs',
  'LeagueofAntonicanBards': 'League of Antonican Bards',
  'AntoniusBayle':        'Antonius Bayle',
  'MerchantsofQeynos':    'Merchants of Qeynos',
  'CorruptQeynosGuards':  'Corrupt Qeynos Guards',
  'CircleofUnseenHands':  'Circle of Unseen Hands',
  // Fear/Hate
  'DenizensofFear':       'Denizens of Fear',
  'InhabitantsofHate':    'Inhabitants of Hate',
  // Misc high-frequency
  'FrogloksofGuk':        'Frogloks of Guk',
  'UndeadFrogloksofGuk':  'Undead Frogloks of Guk',
  'AgentsofMistmoore':    'Agents of Mistmoore',
  'MayongMistmoore':      'Mayong Mistmoore',
  'TempleofSolusekRo':    'Temple of Solusek Ro',
  'GoblinsofMountainDeath': 'Goblins of Mountain Death',
  'GoblinsofCleavingTooth': 'Goblins of Cleaving Tooth',
  'PickclawGoblins':      'Pickclaw Goblins',
  'ShadowedMen':          'Shadowed Men',
  'TheForsaken':          'The Forsaken',
  'Bloodgills':           'Bloodgills',
  'Bloodsabers':          'Bloodsabers',
  'HighpassGuards':       'Highpass Guards',
  'HighGuardofErudin':    'High Guard of Erudite',
  'SplitpawClan':         'Splitpaw Clan',
  'KaranaResidents':      'Karana Residents',
  'PiratesofGunthak':     'Pirates of Gunthak',
  'KingXorbb':            'King Xorbb',
  'Vox':                  'Vox',
  'Nagafen':              'Nagafen',
};

function parseFactionLine(charName, line) {
  const m = line.match(RE_FACTION);
  if (!m) return null;

  const [, logKey, status] = m;
  const displayName = TRACKED_FACTIONS[logKey];
  if (!displayName) return null; // untracked faction

  let newVal;
  const currentVal = getFactionValue(charName, logKey);

  if (status === 'could not possibly get any better') {
    newVal = FACTION_MAX;
  } else if (status === 'could not possibly get any worse') {
    newVal = FACTION_MIN;
  } else if (status === 'got better') {
    const nudge = FACTION_NUDGE_MAP[logKey] || FACTION_NUDGE_DEFAULT;
    if (currentVal === undefined) {
      newVal = LEVEL_MIDPOINTS['Indifferent'] + nudge;
    } else {
      newVal = Math.min(FACTION_MAX, currentVal + nudge);
    }
  } else if (status === 'got worse') {
    const nudge = FACTION_NUDGE_MAP[logKey] || FACTION_NUDGE_DEFAULT;
    if (currentVal === undefined) {
      newVal = LEVEL_MIDPOINTS['Indifferent'] - nudge;
    } else {
      newVal = Math.max(FACTION_MIN, currentVal - nudge);
    }
  } else {
    return null;
  }

  setFactionValue(charName, logKey, newVal);
  const levelName = levelFromValue(newVal);

  return {
    logKey,
    displayName,
    value: newVal,
    level: levelName,
  };
}

// ── Parse a plat amount string into decimal platinum ─────────────────────────
// Handles: "148 platinum 6 copper", "3 gold", "1 platinum 1 gold 8 silver 4 copper"
function parsePlatAmount(str) {
  let total = 0;
  const pp = str.match(/(\d+)\s+platinum/i); if (pp) total += parseInt(pp[1]);
  const gp = str.match(/(\d+)\s+gold/i);     if (gp) total += parseInt(gp[1]) * 0.1;
  const sp = str.match(/(\d+)\s+silver/i);   if (sp) total += parseInt(sp[1]) * 0.01;
  const cp = str.match(/(\d+)\s+copper/i);   if (cp) total += parseInt(cp[1]) * 0.001;
  return Math.round(total * 100) / 100;
}

// ── Extract character name from log filename ─────────────────────────────────
// eqlog_Mixelplex_P1999Green.txt → "Mixelplex"
function charNameFromLog(filename) {
  const base = path.basename(filename);
  const m = base.match(/^eqlog_([^_]+)_/i);
  return m ? m[1] : null;
}

// ── WebSocket server ─────────────────────────────────────────────────────────
// ── Historic kill count scan ──────────────────────────────────────────────────
// Replays the SAME kill-detection rules as the live tail (direct kills,
// in-range charm kills via pet identity, XP-confirmed out-of-range kills,
// login state resets) over entire log files from line one. TTL windows use
// LOG timestamps instead of wall clock. Broadcasts progress + a final result
// set; index.html owns persistence (wipe & rebuild in Supabase).
// Keep the rule blocks below in lockstep with the live handlers above.
let _killScanRunning = false;

const _KS_MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
const RE_LOG_TS = /^\[\w{3} (\w{3}) ([ \d]?\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})\]/;
function _ksParseTs(line) {
  const m = line.match(RE_LOG_TS);
  if (!m) return 0;
  const mon = _KS_MONTHS[m[1]];
  if (mon === undefined) return 0;
  return new Date(+m[6], mon, +m[2], +m[3], +m[4], +m[5]).getTime();
}

function _ksCharFromPath(fp) {
  const m = path.basename(fp).match(/^eqlog_(.+?)_P1999Green\.txt$/i);
  return m ? m[1] : null;
}

function scanOneLogForKills(fp, fileIdx, totalFiles) {
  return new Promise((resolve) => {
    const charName = _ksCharFromPath(fp) || path.basename(fp);
    let fileSize = 1;
    try { fileSize = Math.max(1, fs.statSync(fp).size); } catch(e) {}
    const counts = {};          // zoneLongName → mob → { count, firstTs, lastTs }
    let currentZone  = '';
    let killCredited = false;   // mirrors _killCredited
    let pendingSlain = null;    // mirrors _pendingSlainMob { mob, t }
    let petLastTarget = null;   // mirrors _petLastTarget
    const charmedPets = new Set();
    let activePet   = null;     // mirrors _activePetByChar { petType }
    let charmBroke  = false;    // mirrors _charmBrokeByChar
    let lineTs = 0, lineCount = 0, totalKills = 0;

    const credit = (mob) => {
      const z = currentZone || '';
      if (!counts[z]) counts[z] = {};
      let c = counts[z][mob];
      if (!c) c = counts[z][mob] = { count: 0, firstTs: lineTs, lastTs: lineTs };
      c.count++;
      if (lineTs) { c.lastTs = lineTs; if (!c.firstTs) c.firstTs = lineTs; }
      totalKills++;
    };

    const stream = fs.createReadStream(fp, { encoding: 'utf8' });
    const rl = require('readline').createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      lineCount++;
      const ts = _ksParseTs(line);
      if (ts) lineTs = ts;
      if (lineCount % 250000 === 0) {
        broadcast({ type: 'killScanProgress', charName, fileIdx, totalFiles,
                    pct: Math.min(99, Math.round(stream.bytesRead / fileSize * 100)) });
      }

      // Zone tracking
      const zm = line.match(/You have entered (.+)\./);
      if (zm) { currentZone = zm[1].trim(); return; }

      // Login → state reset (mirrors live sessionLogin block)
      if (RE_SESSION_LOGIN.test(line)) {
        killCredited = false; pendingSlain = null; petLastTarget = null;
        charmedPets.clear(); activePet = null; charmBroke = false;
        return;
      }

      // XP tick (mirrors live: credited flag suppresses double-count;
      // otherwise pending slain-by within TTL, else pet's last target)
      if (RE_SESSION_XP.test(line)) {
        if (killCredited) {
          killCredited = false;
        } else {
          const mobName = (pendingSlain && (lineTs - pendingSlain.t) < CHARM_CONFIRM_MS)
            ? pendingSlain.mob
            : (petLastTarget || 'unknown');
          credit(mobName);
          pendingSlain = null; petLastTarget = null;
        }
      }

      // Direct kill
      const killM = line.match(RE_YOU_SLAIN);
      if (killM) {
        const mob = killM[1].trim();
        credit(mob);
        killCredited = true;
        if (activePet && mob.toLowerCase() === activePet.petType && charmBroke) {
          activePet = null; charmBroke = false;
        }
      }

      // Pet attack tell
      const petAtkM = line.match(RE_PET_ATTACK);
      if (petAtkM) {
        const petName = petAtkM[1].trim().toLowerCase();
        charmedPets.add(petName);
        petLastTarget = petAtkM[2].trim();
        if (!activePet || activePet.petType !== petName) {
          activePet = { petType: petName };
          charmBroke = false;
        }
      }

      // Charm broke
      if (RE_CHARM_BROKE.test(line)) charmBroke = true;

      // Slain-by (mirrors live: known pet → credit; unknown slayer → pending
      // unless it's our own pet dying; own pet death clears charm state)
      const slainByM = line.match(RE_SLAIN_BY_FULL);
      if (slainByM) {
        const slainMob  = slainByM[1].trim();
        const slayerRaw = slainByM[2].trim().toLowerCase();
        const isOwnPet  = !!(activePet && slainMob.toLowerCase() === activePet.petType);
        if (charmedPets.has(slayerRaw)) {
          credit(slainMob);
          killCredited = true;
          petLastTarget = null; pendingSlain = null;
        } else if (!isOwnPet) {
          pendingSlain = { mob: slainMob, t: lineTs };
        }
        if (isOwnPet && !charmedPets.has(slayerRaw)) {
          activePet = null; charmBroke = false;
        }
      }
    });

    rl.on('close', () => resolve({ charName, counts, totalKills, lines: lineCount }));
    stream.on('error', (e) => resolve({ charName, counts, totalKills, lines: lineCount, error: e.message }));
  });
}

async function scanKillCountsAllLogs(charFilter) {
  if (_killScanRunning) {
    broadcast({ type: 'killScanResult', error: 'A scan is already running' });
    return;
  }
  // Only scan logs for roster characters (Characters tab), when provided
  const wanted = Array.isArray(charFilter) && charFilter.length
    ? new Set(charFilter.map(c => String(c).toLowerCase()))
    : null;
  if (false || !CONFIG.LOG_DIR) {
    broadcast({ type: 'killScanResult', error: 'No log directory configured' });
    return;
  }
  _killScanRunning = true;
  try {
    const files = fs.readdirSync(CONFIG.LOG_DIR)
      .filter(f => /^eqlog_.+_P1999Green\.txt$/i.test(f))
      .filter(f => { if (!wanted) return true; const c = _ksCharFromPath(f); return !!(c && wanted.has(c.toLowerCase())); })
      .map(f => path.join(CONFIG.LOG_DIR, f));
    if (!files.length) {
      broadcast({ type: 'killScanResult', error: 'No P1999Green log files found' });
      return;
    }
    console.log(`[KILLSCAN] Scanning ${files.length} log file(s)…`);
    const results = [];
    for (let i = 0; i < files.length; i++) {
      broadcast({ type: 'killScanProgress', charName: _ksCharFromPath(files[i]), fileIdx: i + 1, totalFiles: files.length, pct: 0 });
      const r = await scanOneLogForKills(files[i], i + 1, files.length);
      console.log(`[KILLSCAN] ${r.charName}: ${r.totalKills} kill(s) across ${r.lines} line(s)${r.error ? ' (ERROR: ' + r.error + ')' : ''}`);
      results.push(r);
    }
    broadcast({ type: 'killScanResult', results });
  } catch(e) {
    console.error('[KILLSCAN]', e.message);
    broadcast({ type: 'killScanResult', error: e.message });
  } finally {
    _killScanRunning = false;
  }
}

const wss = new WebSocketServer({ port: CONFIG.WS_PORT, host: '127.0.0.1' });
const clients = new Set();

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  let sent = 0;
  for (const c of clients) {
    if (c.readyState === 1) { c.send(payload); sent++; }
  }
  if (msg.type === "factionUpdate") {
    for (const u of (msg.updates || [])) {
      console.log(`[FACTION] ${msg.charName} | ${u.displayName}: ${u.level} (${u.value > 0 ? '+' : ''}${u.value})${u.source === 'con' ? ' [con]' : ''} → sent to ${sent} client(s)`);
    }
  }
  if (msg.type === "factionSnapshot") {
    for (const [, f] of Object.entries(msg.factions || {})) {
      console.log(`[FACTION] ${msg.charName} | ${f.displayName}: ${f.level} (${f.value > 0 ? '+' : ''}${f.value}) [snapshot] → sent to ${sent} client(s)`);
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('[WS] Client connected (' + clients.size + ' total)');
  ws.send(JSON.stringify({ type: 'hello', secret: CONFIG.WS_SECRET }));

  // Send current faction state snapshot
  for (const [charName, factions] of Object.entries(factionState)) {
    const snapshot = {};
    for (const [logKey, val] of Object.entries(factions)) {
      snapshot[logKey] = {
        displayName: TRACKED_FACTIONS[logKey] || logKey,
        value: val,
        level: levelFromValue(val),
      };
    }
    if (Object.keys(snapshot).length) {
      ws.send(JSON.stringify({ type: 'factionSnapshot', charName, factions: snapshot }));
    }
  }

  // Send current zone state snapshot
  for (const [charName, z] of Object.entries(zoneState)) {
    ws.send(JSON.stringify({ type: 'zoneUpdate', charName, zone: z.zone, timestamp: z.timestamp }));
  }

  // Send cached inventory files
  for (const [filename, content] of Object.entries(invCache)) {
    ws.send(JSON.stringify({ type: 'inventory', filename, content }));
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'requestAll') {
        for (const [fn, ct] of Object.entries(invCache)) {
          ws.send(JSON.stringify({ type: 'inventory', filename: fn, content: ct }));
          console.log(`[INV] requestAll → sent ${fn}`);
        }
        for (const [charName, factions] of Object.entries(factionState)) {
          const snapshot = {};
          for (const [lk, val] of Object.entries(factions)) {
            snapshot[lk] = { displayName: TRACKED_FACTIONS[lk] || lk, value: val, level: levelFromValue(val) };
          }
          if (Object.keys(snapshot).length) {
            ws.send(JSON.stringify({ type: 'factionSnapshot', charName, factions: snapshot }));
          }
        }
      }
      if (msg.type === 'pong') { /* keepalive */ }
      if (msg.type === 'scanKillCounts') { scanKillCountsAllLogs(msg.chars); }
    } catch {}
  });

  ws.on('close', () => { clients.delete(ws); console.log('[WS] Client disconnected (' + clients.size + ' remaining)'); });

  // Keepalive ping
  const pingTimer = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    else clearInterval(pingTimer);
  }, CONFIG.PING_INTERVAL_MS);
});

console.log(`[MixelParse Watcher] WebSocket server on ws://127.0.0.1:${CONFIG.WS_PORT}`);

// ── Inventory watcher ────────────────────────────────────────────────────────
const invCache = {};
const invHashes = {};

function loadInvFile(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const filename = path.basename(filepath);
    const hash = crypto.createHash('md5').update(content).digest('hex');
    if (invHashes[filename] === hash) return; // unchanged — skip
    invHashes[filename] = hash;
    invCache[filename] = content;
    const sentTo = [...clients].filter(c => c.readyState === 1).length;
    broadcast({ type: 'inventory', filename, content });
    console.log(`[INV] ${filename} updated → sent to ${sentTo} client(s)`);
  } catch (e) {
    console.error(`[INV] Error reading ${filepath}: ${e.message}`);
  }
}

// Corpse inventory dumps ("Mixelmedic's corpse1652-Inventory.txt") are not
// characters — /outputfile inventory with a corpse window open creates these.
const RE_CORPSE_INV = /'s corpse\d*-Inventory\.txt$/i;

// Initial scan — read all existing inventory files immediately on startup
function initialInvScan() {
  try {
    const files = fs.readdirSync(CONFIG.INV_DIR);
    const invFiles = files.filter(f => f.endsWith('-Inventory.txt') && !RE_CORPSE_INV.test(f));
    console.log(`[INV] Found ${invFiles.length} inventory file(s) on startup`);
    for (const f of invFiles) {
      loadInvFile(path.join(CONFIG.INV_DIR, f));
    }
  } catch (e) {
    console.error(`[INV] Initial scan error: ${e.message}`);
  }
}

initialInvScan();

// Watch for changes after initial load — watch directory directly (more reliable on Windows)
const invWatcher = chokidar.watch(CONFIG.INV_DIR, {
  persistent: true,
  ignoreInitial: true,
  usePolling: true,
  interval: 1000,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  depth: 0,
});

invWatcher.on('add', fp => { const b = path.basename(fp); if (b.endsWith('-Inventory.txt') && !RE_CORPSE_INV.test(b)) loadInvFile(fp); });
invWatcher.on('change', fp => { const b = path.basename(fp); if (b.endsWith('-Inventory.txt') && !RE_CORPSE_INV.test(b)) loadInvFile(fp); });
invWatcher.on('error', e => console.error('[INV] Watcher error:', e));

// ── EQ Log watcher ────────────────────────────────────────────────────────────
// logPositions[filepath] = byte offset (how far we've read)
// Persisted to disk so restarts don't re-scan history
const _posFile = path.join(__dirname, 'mixelparse-positions.json');
let logPositions = {};
try {
  const raw = fs.readFileSync(_posFile, 'utf8');
  logPositions = JSON.parse(raw);
  console.log('[LOG] Loaded ' + Object.keys(logPositions).length + ' saved position(s) from disk');
} catch (e) {
  console.log('[LOG] No saved positions found, will full-scan all logs');
}
function savePositions() {
  try { fs.writeFileSync(_posFile, JSON.stringify(logPositions)); } catch (e) {}
}

function processLogLines(charName, lines, isLive = false) {
  const updates = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const slainResults = parseSlainLine(charName, trimmed);
    if (slainResults) {
      for (const r of slainResults) updates.push(r);
    }
    const result = parseFactionLine(charName, trimmed) || parseConLine(charName, trimmed);
    if (result) updates.push(result);
    const zoneResult = parseZoneLine(charName, trimmed);
    if (zoneResult) {
      broadcast({ type: 'zoneUpdate', charName, zone: zoneResult.zone, timestamp: zoneResult.timestamp });
      // Clear charm state on zone change
      delete _activePetByChar[charName];
      delete _charmBrokeByChar[charName];
      console.log(`[ZONE] ${charName} → ${zoneResult.zone}`);
    }

    // Location tracking
    const locM = trimmed.match(RE_LOC);
    if (locM) {
      const loc = { x: parseFloat(locM[1]), y: parseFloat(locM[2]), z: parseFloat(locM[3]) };
      _lastLocByChar[charName] = loc;
      if (isLive) broadcast({ type: 'locUpdate', charName, x: loc.x, y: loc.y, z: loc.z });
    }

    // ── Session events (live tail only — not replayed from log history) ──────
    if (isLive) {
      if (RE_SESSION_LOGIN.test(trimmed)) {
        broadcast({ type: 'sessionLogin', charName });
        delete _charmLastCast[charName];
        delete _pendingCharmKill[charName];
        delete _activePetByChar[charName];
        delete _charmBrokeByChar[charName];
        console.log(`[SESSION] ${charName} login detected`);
      }
      if (RE_SESSION_XP.test(trimmed)) {
        broadcast({ type: 'sessionXP', charName });
        // XP confirmation — if a charmed-pet kill is pending within 5 s, credit it now
        const pending = _pendingCharmKill[charName];
        if (pending && (Date.now() - pending.ts) < CHARM_CONFIRM_MS) {
          broadcast({ type: 'sessionKill', charName, mob: pending.mob, loc: _lastLocByChar[charName] || null });
        }
        delete _pendingCharmKill[charName];
      }
      const killM = trimmed.match(RE_YOU_SLAIN);
      if (killM) {
        const mob = killM[1].trim();
        const loc  = _lastLocByChar[charName] || null;
        broadcast({ type: 'sessionKill', charName, mob, loc });
        // Spawn: pet death — player killed the former charm pet after charm broke
        const activePet = _activePetByChar[charName];
        if (activePet && mob.toLowerCase() === activePet.petType && _charmBrokeByChar[charName]) {
          broadcast({ type: 'charmPetDied', charName, petType: activePet.petType, killedByUser: true });
          delete _activePetByChar[charName];
          delete _charmBrokeByChar[charName];
        }
      }
      // Pet attack message → charm acquisition signal
      const petAtkM = trimmed.match(RE_PET_ATTACK);
      if (petAtkM) {
        const petName = petAtkM[1].trim().toLowerCase();
        const prev = _activePetByChar[charName];
        if (!prev || prev.petType !== petName) {
          const loc = _lastLocByChar[charName] || null;
          _activePetByChar[charName] = { petType: petName, loc };
          _charmBrokeByChar[charName] = false;
          broadcast({ type: 'charmAcquired', charName, petType: petName, loc });
        }
      }
      // Charm broke
      if (RE_CHARM_BROKE.test(trimmed)) {
        _charmBrokeByChar[charName] = true;
        broadcast({ type: 'charmBroke', charName });
      }
      // Charm-cast tracking
      const charmCastM = trimmed.match(RE_CHARM_CAST);
      if (charmCastM && CHARM_SPELL_NAMES.has(charmCastM[1])) {
        _charmLastCast[charName] = Date.now();
        console.log(`[SESSION] ${charName} charm cast: ${charmCastM[1]}`);
      }
      // Charmed-pet kill — set pending; XP line confirms and credits it
      const slainByM = trimmed.match(RE_SLAIN_BY_FULL);
      if (slainByM) {
        const slainMob  = slainByM[1].trim();
        const slayerRaw = slainByM[2].trim().toLowerCase();
        const activePet = _activePetByChar[charName];
        const isOwnPet  = !!(activePet && slainMob.toLowerCase() === activePet.petType);
        // Own pet's death is not a session kill — don't stash it, or a nearby
        // XP tick within the confirm window would credit it as a kill.
        if (!isOwnPet) _pendingCharmKill[charName] = { mob: slainMob, ts: Date.now() };
        // Spawn: detect pet death — slain mob IS the active pet
        if (isOwnPet && slayerRaw !== charName.toLowerCase()) {
          broadcast({ type: 'charmPetDied', charName, petType: activePet.petType, killedByUser: false });
          delete _activePetByChar[charName];
          delete _charmBrokeByChar[charName];
        }
      }
      const lootM = trimmed.match(RE_SESSION_LOOT);
      if (lootM) {
        broadcast({ type: 'sessionLoot', charName, item: lootM[1].trim() });
      }
      const vendorM = trimmed.match(RE_SESSION_VENDOR);
      if (vendorM) {
        const plat = parsePlatAmount(vendorM[1]);
        if (plat > 0) broadcast({ type: 'sessionPlat', charName, plat, source: 'vendor' });
      }
      const coinM = trimmed.match(RE_SESSION_COIN);
      if (coinM) {
        const plat = parsePlatAmount(coinM[1]);
        if (plat > 0) broadcast({ type: 'sessionPlat', charName, plat, source: 'coin' });
      }
      if (RE_SESSION_CAMP.test(trimmed)) {
        broadcast({ type: 'sessionCamp', charName });
        delete _charmLastCast[charName];
        delete _pendingCharmKill[charName];
        delete _activePetByChar[charName];
        delete _charmBrokeByChar[charName];
        console.log(`[SESSION] ${charName} camp-out detected`);
      }
    }
  }
  if (updates.length) {
    broadcast({ type: 'factionUpdate', charName, updates });
    for (const u of updates) {
      const src = u.source === 'kill' ? ` [kill ${u.delta > 0 ? '+' : ''}${u.delta}]`
                : u.source === 'con'  ? ' [con]' : ' [log]';
      console.log(`[LOG] ${charName} ${u.displayName} ${u.value > 0 ? '+' : ''}${u.value} (${u.level})${src}`);
    }
  }
}

function tailLogFile(filepath) {
  const charName = charNameFromLog(filepath);
  if (!charName) return;

  try {
    const stat = fs.statSync(filepath);
    const fileSize = stat.size;
    const prevPos = logPositions[filepath];

    if (prevPos === undefined) {
      // First time seeing this file — scan entire history
      // Set position immediately so concurrent change events don't trigger another full scan
      logPositions[filepath] = 0;
      console.log(`[LOG] Initial scan of ${path.basename(filepath)} (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);
      console.log(`[LOG] (tip: delete mixelparse-positions.json to force a full re-scan)`);  
      const stream = fs.createReadStream(filepath, { encoding: 'utf8' });
      let buffer = '';
      let linesProcessed = 0;
      stream.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line
        processLogLines(charName, lines);
        linesProcessed += lines.length;
      });
      stream.on('end', () => {
        if (buffer.trim()) processLogLines(charName, [buffer]);
        logPositions[filepath] = fileSize;
        savePositions();
        console.log(`[LOG] Initial scan complete: ${path.basename(filepath)} (${linesProcessed} lines)`);
      });
      stream.on('error', e => console.error(`[LOG] Stream error: ${e.message}`));
    } else {
      // Tail — only read new bytes
      if (fileSize <= prevPos) {
        if (fileSize < prevPos) {
          // File was truncated or replaced — reset position and do a full scan next time
          console.log(`[LOG] ${path.basename(filepath)}: file shrank (was ${prevPos}, now ${fileSize}) — resetting position for full re-scan`);
          delete logPositions[filepath];
          savePositions();
        }
        return; // no new data
      }
      const stream = fs.createReadStream(filepath, {
        encoding: 'utf8',
        start: prevPos,
        end: fileSize - 1,
      });
      let buffer = '';
      stream.on('data', chunk => { buffer += chunk; });
      stream.on('end', () => {
        const lines = buffer.split('\n');
        processLogLines(charName, lines, true); // isLive=true — fires session events
        logPositions[filepath] = fileSize;
        savePositions();
      });
      stream.on('error', e => console.error(`[LOG] Tail error: ${e.message}`));
    }
  } catch (e) {
    console.error(`[LOG] Error processing ${filepath}: ${e.message}`);
  }
}

// Initial log scan — only process logs for characters we have inventory files for.
// This intentionally limits scanning to chars on the MixelParse site (those with
// inventory files), ignoring other toons on the same PC.
// Override with MY_CHARS in CONFIG if inventory files aren't present for some chars.
function getMyChars() {
  if (CONFIG.MY_CHARS.length) return new Set(CONFIG.MY_CHARS.map(c => c.toLowerCase()));
  // Auto-detect from inventory filenames: Mixelplex-Inventory.txt → mixelplex
  try {
    const files = fs.readdirSync(CONFIG.INV_DIR);
    const chars = files
      .filter(f => f.endsWith('-Inventory.txt') && !RE_CORPSE_INV.test(f))
      .map(f => f.replace(/-Inventory\.txt$/i, '').toLowerCase());
    return new Set(chars);
  } catch (e) {
    return new Set();
  }
}

function initialLogScan() {
  const myChars = getMyChars();
  console.log(`[LOG] Characters from inventory files: ${[...myChars].join(', ')}`);
  try {
    const files = fs.readdirSync(CONFIG.LOG_DIR);
    const logFiles = files.filter(f => {
      if (!/^eqlog_.*_P1999Green\.txt$/i.test(f)) return false;
      const m = f.match(/^eqlog_([^_]+)_/i);
      return m && myChars.has(m[1].toLowerCase());
    });
    // Diagnostic: show which chars have logs and which don't
    const foundChars = new Set(logFiles.map(f => {
      const m = f.match(/^eqlog_([^_]+)_/i);
      return m ? m[1].toLowerCase() : null;
    }).filter(Boolean));
    for (const c of myChars) {
      if (foundChars.has(c)) {
        console.log(`[LOG]   ${c}: log found ✓`);
      } else {
        console.log(`[LOG]   ${c}: NO LOG FILE — faction/con tracking disabled for this char`);
        console.log(`[LOG]          (fix: log in as ${c} and enable logging, or check Logs folder)`);
      }
    }
    for (const f of logFiles) {
      tailLogFile(path.join(CONFIG.LOG_DIR, f));
    }
  } catch (e) {
    console.error(`[LOG] Initial scan error: ${e.message}`);
  }
}

// ── Notes.txt TOD watcher ─────────────────────────────────────────────────────
// Watches EQ notes.txt for entries containing a boss name (fuzzy match).
// When matched, broadcasts { type:'todNote', boss, target, timestamp } to index.html.
// Uses content-based dedup (timestamp+text) so deletions/re-adds don't re-fire.

// Minimal boss list mirroring BOSS_ROSTER in index.html — { target, full, aliases[] }
// aliases are extra keywords that map to this boss (all lowercase)
const NOTES_BOSS_LIST = [
  { target: 'Dozekar',         full: 'Dozekar the Cursed',          aliases: ['dozekar', 'doze'] },
  { target: 'Avatar of War',   full: 'Avatar of War',               aliases: ['avatar', 'aow', 'avt'] },
  { target: 'Dain',            full: 'Dain Frostreaver IV',         aliases: ['dain'] },
  { target: 'Statue',          full: 'Statue of Rallos Zek',        aliases: ['statue', 'srz', 'stat'] },
  { target: 'Takish',          full: 'Guardian of Takish',          aliases: ['takish', 'tak'] },
  { target: 'Tormax',          full: 'King Tormax',                 aliases: ['tormax', 'torm', 'kt'] },
  { target: 'Tunare',          full: 'Tunare',                      aliases: ['tunare', 'tuna'] },
  { target: 'Cazic Thule',     full: 'Cazic Thule',                 aliases: ['cazic', 'caz', 'ct'] },
  { target: 'Eashen',          full: 'Eashen of the Sky',           aliases: ['eashen', 'eas', 'eash'] },
  { target: 'MOTG',            full: 'Master of the Guard',         aliases: ['motg', 'master of the guard'] },
  { target: 'Phara Dar',       full: 'Phara Dar',                   aliases: ['phara', 'phar', 'pd'] },
  { target: 'Prog',            full: 'The Progenitor',              aliases: ['prog', 'progenitor'] },
  { target: 'TFA',             full: 'The Final Arbiter',           aliases: ['tfa', 'arbiter'] },
  { target: 'Vyemm',           full: 'Lord Vyemm',                  aliases: ['vyemm', 'vyem'] },
  { target: 'Yelinak',         full: 'Lord Yelinak',                aliases: ['yelinak', 'yeli', 'yel'] },
  { target: 'Aaryonar',        full: 'Aaryonar',                    aliases: ['aaryonar', 'aary'] },
  { target: 'Dagarn',          full: 'Dagarn the Destroyer',        aliases: ['dagarn', 'dag'] },
  { target: 'Dracoliche',      full: 'Dracoliche',                  aliases: ['dracoliche', 'draco', 'drac'] },
  { target: 'Druushk',         full: 'Druushk',                     aliases: ['druushk', 'druu'] },
  { target: 'Feshlak',         full: 'Lord Feshlak',                aliases: ['feshlak', 'fesh'] },
  { target: 'Hoshkar',         full: 'Hoshkar',                     aliases: ['hoshkar', 'hosh'] },
  { target: 'Jorlleag',        full: 'Jorlleag',                    aliases: ['jorlleag', 'jorl'] },
  { target: 'Klandicar',       full: 'Klandicar',                   aliases: ['klandicar', 'klan', 'klandi'] },
  { target: 'Koi',             full: "Lord Koi'Doken",              aliases: ['koi'] },
  { target: 'Kreizenn',        full: 'Lord Kreizenn',               aliases: ['kreizenn', 'krei', 'kreiz'] },
  { target: 'LTK',             full: 'Lendiniara the Keeper',       aliases: ['ltk'] },
  { target: "Magi P'Tasa",     full: "Magi P'Tasa",                 aliases: ['magi'] },
  { target: 'Mirenilla',       full: 'Lady Mirenilla',              aliases: ['mirenilla', 'mire', 'mir', 'ladym'] },
  { target: 'Nevederia',       full: 'Lady Nevederia',              aliases: ['nevederia', 'neve', 'nev', 'ladyn'] },
  { target: 'Sontalak',        full: 'Sontalak',                    aliases: ['sontalak', 'sont', 'son'] },
  { target: 'Vulak',           full: "Vulak'Aerr",                  aliases: ['vulak', 'vul'] },
  { target: 'Zlandicar',       full: 'Zlandicar',                   aliases: ['zlandicar', 'zlan', 'zlandi'] },
  { target: 'Ashenbone Broodmaster', full: 'Ashenbone Broodmaster', aliases: ['ashen', 'brod', 'brood'] },
  { target: 'Bazzt Zzzt',      full: 'Bazzt Zzzt',                  aliases: ['bazzt', 'bazz'] },
  { target: 'Cekenar',         full: 'Cekenar',                     aliases: ['cekenar', 'cek'] },
  { target: 'Essedera',        full: 'Essedera',                    aliases: ['essedera', 'esse', 'ess'] },
  { target: 'Gorenaire',       full: 'Gorenaire',                   aliases: ['gorenaire', 'gore', 'goren'] },
  { target: 'Gozzrem',         full: 'Gozzrem',                     aliases: ['gozzrem', 'gozz'] },
  { target: 'Ikatiar',         full: 'Ikatiar the Venom',           aliases: ['ikatiar', 'ikat', 'ikky'] },
  { target: 'Kelorek Dar',     full: 'Kelorek Dar',                 aliases: ['kelorek', 'kelo'] },
  { target: 'Kozzalym',        full: 'Kozzalym',                    aliases: ['kozzalym', 'kozz'] },
  { target: 'Lepethida',       full: 'Lepethida',                   aliases: ['lepethida', 'lep'] },
  { target: 'Lord of Ire',     full: 'Lord of Ire',                 aliases: ['ire'] },
  { target: 'Nexona',          full: 'Nexona',                      aliases: ['nexona', 'nex'] },
  { target: 'Sevalak',         full: 'Sevalak',                     aliases: ['sevalak', 'seva', 'sev'] },
  { target: 'Severilous',      full: 'Severilous',                  aliases: ['severilous', 'sevr'] },
  { target: 'Silverwing',      full: 'Silverwing',                  aliases: ['silverwing', 'silv', 'sw'] },
  { target: 'Trakanon',        full: 'Trakanon',                    aliases: ['trakanon', 'trak'] },
  { target: 'VS',              full: 'Venril Sathir',               aliases: ['vs', 'venril'] },
  { target: 'Vaniki',          full: 'Vaniki',                      aliases: ['vaniki', 'van'] },
  { target: 'Vox',             full: 'Lady Vox',                    aliases: ['vox'] },
  { target: 'Xygoz',           full: 'Xygoz',                       aliases: ['xygoz', 'xyg'] },
  { target: 'Zlexak',          full: 'Zlexak',                      aliases: ['zlexak', 'zlex'] },
  { target: 'Dread',           full: 'Dread',                       aliases: ['dread'] },
  { target: 'Fright',          full: 'Fright',                      aliases: ['fright'] },
  { target: 'Naggy',           full: 'Lord Nagafen',                aliases: ['naggy', 'nagafen'] },
  { target: 'Talendor',        full: 'Talendor',                    aliases: ['talendor', 'tal'] },
  { target: 'Telk',            full: 'Telkorenar',                  aliases: ['telk', 'telkorenar'] },
  { target: 'Terror',          full: 'Terror',                      aliases: ['terror', 'terr'] },
  { target: 'Velketor',        full: 'Velketor the Sorcerer',       aliases: ['velketor', 'velk'] },
  { target: 'Garzicor',        full: 'Garzicor',                    aliases: ['garzicor', 'garz'] },
  { target: 'Inny',            full: 'Innoruuk',                    aliases: ['inny', 'innoruuk'] },
  { target: 'KDT',             full: "Keldor Dek'Torek",            aliases: ['kdt', 'keldor'] },
  { target: 'Vindi',           full: 'Derakor the Vindicator',      aliases: ['vindi', 'derakor'] },
  { target: 'Wuoshi',          full: 'Wuoshi',                      aliases: ['wuoshi', 'wuo', 'wush'] },
  { target: 'Yael',            full: 'Yael',                        aliases: ['yael'] },
  { target: 'UDB',             full: 'Undead Bard (Trakanon)',       aliases: ['udb', 'undead bard'] },
  { target: 'Lord Bob',        full: 'Lord Doljonijiarnimorinar',   aliases: ['lord bob', 'bob'] },
  { target: 'Vilefang',        full: 'Vilefang',                    aliases: ['vilefang', 'vile'] },
  { target: 'Avatar of Abhorrence', full: 'Avatar of Abhorrence',    aliases: ['abhor'] },
  { target: "Coercer T'vala",       full: "Coercer T'vala",           aliases: ['coercer'] },
  { target: "Grandmaster R'Tal",    full: "Grandmaster R'Tal",        aliases: ['grandmaster', 'rtal'] },
  { target: "High Priest M'kari",   full: "High Priest M'kari",       aliases: ['mkari'] },
  { target: 'Lord of Loathing',     full: 'Lord of Loathing',         aliases: ['loathing', 'lord of loathing', 'lord'] },
  { target: 'Master of Spite',      full: 'Master of Spite',          aliases: ['spite', 'master of spite', 'master'] },
  { target: 'Mistress of Scorn',    full: 'Mistress of Scorn',        aliases: ['scorn', 'mistress of scorn', 'mistress'] },
  { target: 'Casalen',         full: 'Casalen',                     aliases: ['casalen', 'cas'] },
  { target: 'Grozzmel',        full: 'Grozzmel',                    aliases: ['grozzmel', 'grozz'] },
  { target: 'Krigara',         full: 'Krigara',                     aliases: ['krigara', 'krig'] },
  { target: 'Midayor',         full: 'Midayor',                     aliases: ['midayor', 'mid'] },
  { target: 'Tavekalem',       full: 'Tavekalem',                   aliases: ['tavekalem', 'tave', 'tav'] },
  { target: 'Ymmeln',          full: 'Ymmeln',                      aliases: ['ymmeln', 'ymm'] },
];

// /note aliases for Hourly Ticks DKP entries — checked after NOTES_BOSS_LIST.
// desc/value must match HOURLY_ROLES in index.html exactly.
const NOTES_TICK_MAP = [
  { desc: 'Ticks - Standard (hourly)',        value: 1, aliases: ['standard', 'hourly', 'std'] },
  { desc: 'Ticks - NToV/Sky/VP (hourly)',     value: 2, aliases: ['ntov', 'sky', 'vp'] },
  { desc: 'Ticks - Training Events (hourly)', value: 3, aliases: ['training', 'train'] },
];

// /note aliases for Ring War checkpoints — toggles the checkpoint directly,
// no kill modal. key must match RW_CHECKPOINTS keys in index.html exactly.
// Mirrors _NOTES_RW_MAP in index.html.
const NOTES_RW_MAP = [
  { key: 'readiness', aliases: ['rwready', 'rw ready'] },
  { key: 'wave1',      aliases: ['rw1', 'rw wave 1'] },
  { key: 'wave2',      aliases: ['rw2', 'rw wave 2'] },
  { key: 'wave3',      aliases: ['rw3', 'rw wave 3'] },
];

// /note alias for HoT Farm Ticks — mirrors clicking + on the HoT Farm Ticks row.
// Mirrors _NOTES_HOT_MAP in index.html.
const NOTES_HOT_MAP = [
  { aliases: ['hotfarm', 'hot'] },
];

// RE: [Day Mon DD HH:MM:SS YYYY ] text
const RE_NOTE_LINE = /^\[(\w+ \w+ +\d+ [\d:]+ \d+) \] (.+)$/;

// Track file position so we only process lines written after watcher started
let _notesPos = 0;

function fuzzyMatchBoss(text) {
  const t = text.toLowerCase().trim();
  for (const boss of NOTES_BOSS_LIST) {
    if (t.includes(boss.full.toLowerCase())) return boss;
    for (const alias of boss.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|\\s)' + escaped + '(\\s|$)', 'i');
      if (re.test(t)) return boss;
    }
  }
  return null;
}

function fuzzyMatchTick(text) {
  const t = text.toLowerCase().trim();
  for (const tick of NOTES_TICK_MAP) {
    for (const alias of tick.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|\\s)' + escaped + '(\\s|$)', 'i');
      if (re.test(t)) return tick;
    }
  }
  return null;
}

function fuzzyMatchRW(text) {
  const t = text.toLowerCase().trim();
  for (const rw of NOTES_RW_MAP) {
    for (const alias of rw.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|\\s)' + escaped + '(\\s|$)', 'i');
      if (re.test(t)) return rw;
    }
  }
  return null;
}

function fuzzyMatchHot(text) {
  const t = text.toLowerCase().trim();
  for (const hot of NOTES_HOT_MAP) {
    for (const alias of hot.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|\\s)' + escaped + '(\\s|$)', 'i');
      if (re.test(t)) return hot;
    }
  }
  return null;
}

function processNotesLines(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(RE_NOTE_LINE);
    if (!m) continue;
    const timestamp = m[1];
    const text = m[2];

    // ── Spawn pin placement: "/note set AA" or "/note set AA 22:00" ──────────
    const setM = text.match(/^set\s+([A-Za-z0-9]{1,8})(?:\s+(\d+:\d+))?$/i);
    if (setM) {
      const pin      = setM[1].toUpperCase();
      const timerStr = setM[2] || null;
      const locVals  = Object.values(_lastLocByChar);
      const loc      = locVals.length > 0 ? locVals[locVals.length - 1] : null;
      broadcast({ type: 'spawnPinSet', pin, timerStr, loc, timestamp });
      console.log(`[SPAWN] Pin set: ${pin}${timerStr ? ' ('+timerStr+')' : ''}`);
      continue;
    }

    // ── Zone timer update: "/note timer 22:00" ───────────────────────────────
    const timerM = text.match(/^timer\s+(\d+:\d+)$/i);
    if (timerM) {
      broadcast({ type: 'zoneTimerSet', timerStr: timerM[1], timestamp });
      console.log(`[SPAWN] Zone timer set: ${timerM[1]}`);
      continue;
    }
    const boss = fuzzyMatchBoss(text);
    if (boss) {
      console.log(`[NOTES] TOD detected: "${text}" → ${boss.target} (${boss.full})`);
      broadcast({ type: 'todNote', target: boss.target, full: boss.full, noteText: text, timestamp });
      continue;
    }
    const tick = fuzzyMatchTick(text);
    if (tick) {
      console.log(`[NOTES] Tick detected: "${text}" → ${tick.desc}`);
      broadcast({ type: 'todTick', desc: tick.desc, value: tick.value, noteText: text, timestamp });
      continue;
    }
    const rw = fuzzyMatchRW(text);
    if (rw) {
      console.log(`[NOTES] Ring War checkpoint detected: "${text}" → ${rw.key}`);
      broadcast({ type: 'todRW', key: rw.key, noteText: text, timestamp });
      continue;
    }
    const hot = fuzzyMatchHot(text);
    if (hot) {
      console.log(`[NOTES] HoT Farm Tick detected: "${text}"`);
      broadcast({ type: 'todHot', noteText: text, timestamp });
    }
  }
}

function tailNotesFile(filepath) {
  try {
    const stat = fs.statSync(filepath);
    if (stat.size <= _notesPos) return; // no new content
    const fd = fs.openSync(filepath, 'r');
    const buf = Buffer.alloc(stat.size - _notesPos);
    const read = fs.readSync(fd, buf, 0, buf.length, _notesPos);
    fs.closeSync(fd);
    _notesPos += read;
    const lines = buf.slice(0, read).toString('utf8').split('\n');
    processNotesLines(lines);
  } catch (e) {
    console.error(`[NOTES] Error reading notes file: ${e.message}`);
  }
}

// On startup, seek to end of file — only process new notes written after watcher starts
if (fs.existsSync(CONFIG.NOTES_FILE)) {
  try {
    _notesPos = fs.statSync(CONFIG.NOTES_FILE).size;
    console.log(`[NOTES] notes.txt found — seeked to end (${_notesPos} bytes), watching for new entries`);
  } catch (e) {
    console.log(`[NOTES] Could not stat notes file: ${e.message}`);
  }
} else {
  console.log(`[NOTES] notes.txt not found at ${CONFIG.NOTES_FILE} — will watch for creation`);
}

const notesWatcher = chokidar.watch(CONFIG.NOTES_FILE, {
  persistent: true,
  ignoreInitial: true,
  usePolling: true,
  interval: 1000,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  disableGlobbing: true,
});
notesWatcher.on('add',    fp => { _notesPos = 0; tailNotesFile(fp); });
notesWatcher.on('change', fp => tailNotesFile(fp));
notesWatcher.on('error',  e  => console.error('[NOTES] Watcher error:', e));

initialLogScan();

// Startup: scan existing log files to populate zone state immediately
try {
  const myChars = getMyChars();
  const files = fs.readdirSync(CONFIG.LOG_DIR);
  for (const f of files) {
    if (!/^eqlog_.+_P1999Green\.txt$/i.test(f)) continue;
    const m = f.match(/^eqlog_([^_]+)_/i);
    if (!m || !myChars.has(m[1].toLowerCase())) continue;
    const charName = m[1];
    const fp = path.join(CONFIG.LOG_DIR, f);
    // Scan last 50KB for most recent zone line
    try {
      const stat = fs.statSync(fp);
      const readSize = Math.min(50 * 1024, stat.size);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(fp, 'r');
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').reverse();
      for (const line of lines) {
        const zm = line.match(/You have entered (.+)\./);
        if (zm) {
          const zone = zm[1].trim();
          zoneState[charName] = { zone, timestamp: new Date().toISOString() };
          console.log(`[ZONE] ${charName} startup zone → ${zone}`);
          break;
        }
      }
    } catch (e) {
      console.error(`[ZONE] Startup scan error for ${charName}: ${e.message}`);
    }
  }
  // Save and broadcast all found zones
  saveZoneState();
} catch (e) {
  console.error('[ZONE] Startup scan failed:', e.message);
}

// Watch for changes — only tail files for our chars
const logWatcher = chokidar.watch(CONFIG.LOG_DIR, {
  persistent: true,
  ignoreInitial: true,
  usePolling: true,
  interval: 1000,
});

logWatcher.on('add', fp => {
  const myChars = getMyChars();
  const m = path.basename(fp).match(/^eqlog_([^_]+)_/i);
  if (m && myChars.has(m[1].toLowerCase())) {
    console.log(`[LOG] New log file detected for ${m[1]} — starting tail`);
    tailLogFile(fp);
  }
});
logWatcher.on('change', fp => {
  if (!/eqlog_.+_P1999Green\.txt$/i.test(fp)) return;
  const myChars = getMyChars();
  const m = path.basename(fp).match(/^eqlog_([^_]+)_/i);
  if (m && myChars.has(m[1].toLowerCase())) tailLogFile(fp);
});
logWatcher.on('error', e => console.error('[LOG] Watcher error:', e));

console.log(`[MixelParse Watcher] Watching inventory: ${CONFIG.INV_DIR}`);
console.log(`[MixelParse Watcher] Watching EQ logs:   ${CONFIG.LOG_DIR}`);
console.log(`[MixelParse Watcher] Watching notes:     ${CONFIG.NOTES_FILE}`);
console.log('[MixelParse Watcher] Ready.\n');
