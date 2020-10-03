import settings from './settings.json'
import Telegraf from 'telegraf'
import firebase from 'firebase-admin'

const bot = new Telegraf(`${settings.bot_token}`);
const botId = +settings.bot_token.split(':')[0];
const firestore = firebase.initializeApp({
    credential: firebase.credential.cert(settings.firebase.credential),
    databaseURL: settings.firebase.databaseURL,
}).firestore();

const day = 60 * 60 * 24;

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

/** @type {{[id: number]: number}} */
const userMessageCount = createLinkedObject('messages');
/** @type {{[id: number]: number}} */
const warnMessageCount = createLinkedObject('warnings');
/** @type {{[id: number]: number}} */
const firstMessageTime = createLinkedObject('first_message_time');
/** @type {{[id: number]: number}} */
const restrictions = createLinkedObject('restrictions');

async function deleteMessage(ctx){
    await Promise.all([
        ctx.deleteMessage(),
        ctx.replyWithMarkdown(`[${ctx.from.first_name}](tg://user?id=${ctx.from.id}), сообщение удалено. Проведите сначала побольше времени в чате, пообщайтесь, а потом уже кидайте ссылки, упоминания или фото`),
    ])
}

function check(ctx, message, doDeleteMessage = true){
    if(!(ctx.from.id in userMessageCount)) userMessageCount[ctx.from.id] = 0;
    if(
        ctx.message.date - firstMessageTime[ctx.from.id] < rules.minTimeCount
     || userMessageCount[ctx.from.id] < rules.minMessageCount
    ){
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
    if(!(ctx.from.id in firstMessageTime)) firstMessageTime[ctx.from.id] = ctx.message.date;
    if(check(ctx, ctx.message)) userMessageCount[ctx.from.id]++;
    return next()
});

bot.on('edited_message', (ctx, next) => {
    check(ctx, ctx.update.edited_message);
    return next()
});

bot.command('warn', (ctx, next) => {
    if(warnMessageCount[id] === 3) return next();
    const { id } = ctx.message.reply_to_message.from;
    if(id === botId){
        ctx.replyWithMarkdown(`[${ctx.from.first_name}](tg://user?id=${ctx.from.id}), я щас тебя забаню`);
        return next()
    }
    if(!(id in warnMessageCount)) warnMessageCount[id] = 1;
    else warnMessageCount[id]++;
    if(warnMessageCount[id] === 3){
        const now = Math.floor(Date.now() / 1000);
        if(!(id in restrictions)) restrictions[id] = 0;
        const restrictTime = rules.restrictionLevels[++restrictions[id]];
        ctx.restrictChatMember(id, {
            permissions: {},
            until_date: now + restrictTime,
        });
    }
});

bot.startPolling()
