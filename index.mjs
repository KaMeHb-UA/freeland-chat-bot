import settings from './settings.json'
import Telegraf from 'telegraf'
import firebase from 'firebase-admin'

const bot = new Telegraf(`${settings.bot_token}`);
const botId = +settings.bot_token.split(':')[0];
const firestore = firebase.initializeApp({
    credential: firebase.credential.cert(settings.firebase.credential),
    databaseURL: settings.firebase.databaseURL,
}).firestore();

const allowedLinks = [
    /^(https?:\/\/)?(.+\.)?mfcoin\.net(\/.*)?$/,
    /^(https?:\/\/)?(www\.)?t\.me\/mfcoin(ru|en)(\/.*)?$/,
    /^(https?:\/\/)?(www\.)?facebook\.com\/groups\/mfcoin(\/.*)?$/,
    /^(https?:\/\/)?vk\.com\/mfcoin(\/.*)?$/,
    /^(https?:\/\/)?bitcointalk\.org\/index\.php\?topic=(3302663|3098405)(&.*)?$/
];

const restrictUser = {
    can_send_messages: false,
    can_send_media_messages: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_change_info: false,
    can_invite_users: false,
    can_pin_messages: false,
};
/** @type { typeof restrictUser } */
const unrestrictUser = {};
for(const i in restrictUser) unrestrictUser[i] = !restrictUser[i];

const day = 60 * 60 * 24;

const rules = {
    forbiddenEntities: [
        'mention',
        'url',
        'text_link',
        'text_mention',
    ],
    allowedEntities: {
        url: [ allowedLinks, (e, ctx) => ctx.message.text.slice(e.offset, e.offset + e.length) ],
        text_link: [ allowedLinks, e => e.url ],
    },
    forbiddenTypes: [
        'photo',
    ],
    minMessageCount: 5,
    minTimeCount: day,
    restrictionLevels:{
        1: day,
        2: day * 7,
        3: day * 30,
        4: day * 365,
        5: day * 3653,
    }
};

function createLinkedObject(collectionName){
    const _ = Object.create(null);
    firestore.collection(collectionName).onSnapshot(snap => {
        for(const doc of snap.docs) _[doc.id] = doc.data().data;
    });
    return new Proxy(_, {
        get(_, id){
            return _[id]
        },
        set(_, id, value){
            _[id] = value;
            firestore.collection(collectionName).doc(id).set({ data: value });
            return true
        },
    })
}

function createLinkedBooleanMap(collectionName){
    /** @type {{[id: number]: {[x: number]: boolean}}} */
    const proxy = new Proxy(Object.create(null), {
        get(_, id){
            if(!(id in _)) _[id] = new Proxy(Object.create(null), {
                get(__, warner){
                    return !!__[warner]
                },
                set(__, warner, value){
                    __[warner] = !!value;
                    firestore.collection(collectionName).doc(id).set(__);
                    return true
                },
            });
            return _[id]
        },
        set(_, id, value){
            return false
        },
    });
    firestore.collection(collectionName).onSnapshot(snap => {
        for(const doc of snap.docs) Object.assign(proxy[doc.id], doc.data())
    });
    return proxy
}

/** @type {{[id: number]: number}} */
const userMessageCount = createLinkedObject('messages');
/** @type {{[id: number]: number}} */
const warnMessageCount = createLinkedObject('warnings');
/** @type {{[id: number]: number}} */
const firstMessageTime = createLinkedObject('first_message_time');
/** @type {{[id: number]: number}} */
const restrictions = createLinkedObject('restrictions');
const warnMap = createLinkedBooleanMap('warn_map');
const unwarnMap = createLinkedBooleanMap('unwarn_map');

async function deleteMessage(ctx){
    await Promise.all([
        ctx.deleteMessage(),
        ctx.replyWithMarkdown(`[${ctx.from.first_name}](tg://user?id=${ctx.from.id}), сообщение удалено. Проведите сначала побольше времени в чате, пообщайтесь, а потом уже кидайте ссылки, упоминания или фото`),
    ])
}

function check(ctx, message, doDeleteMessage = true){
    if(!(ctx.from.id in userMessageCount)) userMessageCount[ctx.from.id] = 0;
    if(
        message.date - firstMessageTime[ctx.from.id] < rules.minTimeCount
     || userMessageCount[ctx.from.id] < rules.minMessageCount
    ){
        if(message.entities) for(const entity of message.entities) if(rules.forbiddenEntities.includes(entity.type)){
            if(entity.type in rules.allowedEntities){
                const [ allowed, valueGetter ] = rules.allowedEntities[entity.type];
                const entityValue = valueGetter(entity, ctx);
                const isValueAllowed = allowed.map(v => v.test(entityValue)).reduce((prev, curr) => prev || curr);
                if(!isValueAllowed){
                    if(doDeleteMessage) deleteMessage(ctx)
                    return false
                }
            } else {
                if(doDeleteMessage) deleteMessage(ctx)
                return false
            }
        }
        for(const type of rules.forbiddenTypes) if(message[type]){
            if(doDeleteMessage) deleteMessage(ctx)
            return false
        }
    }
    return true
}

bot.on('message', (ctx, next) => {
    if(ctx.chat.id !== settings.chatId) return next();
    if(ctx.message.new_chat_members && ctx.message.new_chat_members.length) return next();
    if(!(ctx.from.id in firstMessageTime)) firstMessageTime[ctx.from.id] = ctx.message.date;
    if(check(ctx, ctx.message)) userMessageCount[ctx.from.id]++;
    return next()
});

bot.on('edited_message', (ctx, next) => {
    if(ctx.chat.id !== settings.chatId) return next();
    check(ctx, ctx.update.edited_message);
    return next()
});

bot.command('warn', (ctx, next) => {
    if(ctx.chat.id !== settings.chatId) return next();
    const id = ctx.message.reply_to_message?.from?.id;
    if(!id || warnMessageCount[id] === 3 || warnMap[id][ctx.message.from.id]) return next();
    if(id === botId) return next();
    warnMap[id][ctx.message.from.id] = true;
    if(!(id in warnMessageCount)) warnMessageCount[id] = 1;
    else warnMessageCount[id]++;
    if(warnMessageCount[id] === 3){
        const now = Math.floor(Date.now() / 1000);
        if(!(id in restrictions)) restrictions[id] = 0;
        const restrictTime = rules.restrictionLevels[++restrictions[id]];
        ctx.restrictChatMember(id, {
            permissions: restrictUser,
            until_date: now + restrictTime,
        });
        ctx.replyWithMarkdown(`[${ctx.message.reply_to_message.from.first_name}](tg://user?id=${id}), Вы были заблокированы решением комьюнити`)
    }
});

bot.command('unwarn', (ctx, next) => {
    if(ctx.chat.id !== settings.chatId) return next();
    const id = ctx.message.reply_to_message?.from?.id;
    if(!id || warnMessageCount[id] === 0 || unwarnMap[id][ctx.message.from.id]) return next();
    if(id === botId) return next();
    unwarnMap[id][ctx.message.from.id] = true;
    if(!(id in warnMessageCount)) warnMessageCount[id] = 0;
    else warnMessageCount[id]--;
    if(warnMessageCount[id] === 0){
        if(!(id in restrictions)) restrictions[id] = 0;
        ctx.restrictChatMember(id, {
            permissions: unrestrictUser,
        });
        ctx.replyWithMarkdown(`[${ctx.message.reply_to_message.from.first_name}](tg://user?id=${id}), поздравляем, Вы снова можете писать в чат, все ограничения были сняты`)
    }
});

bot.startPolling()
