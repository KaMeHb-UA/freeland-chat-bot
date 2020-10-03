import settings from './settings.json'
import Telegraf from 'telegraf'

const bot = new Telegraf(`${settings.bot_token}`);

const rules = {
    forbiddenEntities: [
        'mention',
        'url',
        'text_link',
        'text_mention',
    ],
    forbiddenTypes: [
        'photo',
    ],
    minMessageCount: 5,
    minTimeCount: 60 * 60 * 24,
};

function createLinkedObject(collectionName){
    const _ = Object.create(null);
    return new Proxy(_, {
        get(_, id){
            return _[id] || 0
        },
        set(_, id, value){
            _[id] = value;
            return true
        },
    })
}

/** @type {{[id: number]: number}} */
const userMessageCount = createLinkedObject('messages');
/** @type {{[id: number]: number}} */
const warnMessageCount = createLinkedObject('warnings');
/** @type {{[id: number]: number}} */
const firstMessageTime = createLinkedObject('first_message_time');

async function deleteMessage(ctx){
    await Promise.all([
        ctx.deleteMessage(),
        ctx.replyWithMarkdown(`[${ctx.from.first_name}](tg://user?id=${ctx.from.id}), сообщение удалено. Проведите сначала побольше времени в чате, пообщайтесь, а потом уже кидайте ссылки, упоминания или фото`),
    ])
}

function check(ctx, message, doDeleteMessage = true){
    if(
        ctx.message.date - firstMessageTime[ctx.from.id] < rules.minTimeCount
     || (userMessageCount[ctx.from.id] || 0) < rules.minMessageCount)
    {
        if(message.entities) for(const entity of message.entities) if(rules.forbiddenEntities.includes(entity.type)){
            if(doDeleteMessage) deleteMessage(ctx)
            return false
        }
        for(const type of rules.forbiddenTypes) if(message[type]){
            if(doDeleteMessage) deleteMessage(ctx)
            return false
        }
    }
    return true
}

bot.on('message', (ctx, next) => {
    if(ctx.message.new_chat_members && ctx.message.new_chat_members.length) return next();
    if(!(ctx.from.id) in firstMessageTime) firstMessageTime[ctx.from.id] = ctx.message.date;
    if(check(ctx, ctx.message)) userMessageCount[ctx.from.id]++;
    return next()
});

bot.on('edited_message', (ctx, next) => {
    check(ctx, ctx.update.edited_message);
    return next()
});

bot.command('warn', (ctx, next) => {
    ctx.message.reply_to_message.from.id
})

bot.startPolling()
