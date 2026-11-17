import test from 'node:test'
import assert from 'node:assert/strict'
import { discordChannelMember } from '../dist/membership.js'

const guild = '20000000000000002', channel = '30000000000000003', user = '40000000000000004', other = '50000000000000005'
const responses = over => ({
 [`/guilds/${guild}/members/${user}`]: { user: { id: user }, roles: [] },
 [`/channels/${channel}`]: { id: channel, guild_id: guild, type: 0, permission_overwrites: [] },
 [`/guilds/${guild}`]: { id: guild, owner_id: other },
 [`/guilds/${guild}/roles`]: [{ id: guild, permissions: '1024' }],
 ...over,
})
const member = over => discordChannelMember(async (_method, path) => responses(over)[path], channel, guild, user)

test('a consistent response authorizes through the everyone role', async () => {
 assert.equal(await member({}), true)
})
for (const [name, over] of [
 ['member object for another user', { [`/guilds/${guild}/members/${user}`]: { user: { id: other }, roles: [] } }],
 ['channel with another id', { [`/channels/${channel}`]: { id: other, guild_id: guild, type: 0, permission_overwrites: [] } }],
 ['channel in another guild', { [`/channels/${channel}`]: { id: channel, guild_id: other, type: 0, permission_overwrites: [] } }],
 ['guild with another id', { [`/guilds/${guild}`]: { id: other, owner_id: user } }],
 ['member role absent from the role list', { [`/guilds/${guild}/members/${user}`]: { user: { id: user }, roles: [other] } }],
]) test(`${name} is unknown, never a confident answer`, async () => {
 assert.equal(await member(over), undefined)
})
test('a member denied VIEW_CHANNEL is refused, a personal allow wins', async () => {
 const deny = { id: guild, type: 0, deny: '1024', allow: '0' }
 const overwrites = permission_overwrites => ({ [`/channels/${channel}`]: { id: channel, guild_id: guild, type: 0, permission_overwrites } })
 assert.equal(await member(overwrites([deny])), false)
 assert.equal(await member(overwrites([deny, { id: user, type: 1, deny: '0', allow: '1024' }])), true)
})
test('a missing everyone role is unknown', async () => {
 assert.equal(await member({ [`/guilds/${guild}/roles`]: [] }), undefined)
})
