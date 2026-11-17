import { z } from 'zod'
import { snowflake } from './identity.js'
export type Request = (method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>
const perms = z.string().regex(/^\d{1,30}$/)
export async function discordChannelMember(request: Request, channelId: string, guildId: string, userId: string, signal?: AbortSignal) {
 const member = z.object({ user: z.object({ id: snowflake }), roles: z.array(snowflake) }).safeParse(await request('GET', `/guilds/${guildId}/members/${userId}`, undefined, signal)); if (!member.success || member.data.user.id !== userId) return
 const channel = z.object({ id: snowflake, guild_id: snowflake, type: z.literal(0), permission_overwrites: z.array(z.object({ id: snowflake, type: z.union([z.literal(0), z.literal(1)]), allow: perms, deny: perms })) }).safeParse(await request('GET', `/channels/${channelId}`, undefined, signal)); if (!channel.success || channel.data.id !== channelId || channel.data.guild_id !== guildId) return
 const guild = z.object({ id: snowflake, owner_id: snowflake }).safeParse(await request('GET', `/guilds/${guildId}`, undefined, signal)); if (!guild.success || guild.data.id !== guildId) return
 if (guild.data.owner_id === userId) return true
 const roles = z.array(z.object({ id: snowflake, permissions: perms })).safeParse(await request('GET', `/guilds/${guildId}/roles`, undefined, signal)); if (!roles.success || !roles.data.some(r => r.id === guildId) || member.data.roles.some(id => !roles.data.some(r => r.id === id))) return
 let allowed = roles.data.filter(r => r.id === guildId || member.data.roles.includes(r.id)).reduce((n, r) => n | BigInt(r.permissions), 0n); if (allowed & 8n) return true
 const everyone = channel.data.permission_overwrites.find(r => r.type === 0 && r.id === guildId); if (everyone) allowed = (allowed & ~BigInt(everyone.deny)) | BigInt(everyone.allow)
 const assigned = channel.data.permission_overwrites.filter(r => r.type === 0 && member.data.roles.includes(r.id)); allowed = (allowed & ~assigned.reduce((n, r) => n | BigInt(r.deny), 0n)) | assigned.reduce((n, r) => n | BigInt(r.allow), 0n)
 const personal = channel.data.permission_overwrites.find(r => r.type === 1 && r.id === userId); if (personal) allowed = (allowed & ~BigInt(personal.deny)) | BigInt(personal.allow)
 return (allowed & 1024n) !== 0n
}
