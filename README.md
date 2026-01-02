[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/S6S3RQ02Q)

This is a pomodoro timer / co-work chat bot for twitch

## Help (can be done by anyone)
`!coworkhelp`

this takes the requester into account and only shows commands they can use

## Tasks (can be done by anyone)
`!task <task text>`

adds the listed text as a task for that user, with an incrementing number for easier tracking

`!edit <task number> <new task text>`

edits the specified task number with the new text

`!done <task number>`

marks the numbered task as complete, removes it from the list, increments the goal progress, completed counter, and leaderboard

## Timer (only mods and the streamer can run these)

`!focus <minutes>`

if no time is specified, starts a 25 minute timer. otherwise, starts a timer for that number of minutes

`!break <minutes>`

same as !focus, but for the break timer

`!pause` and `!resume`

pauses and resumes the timer

## Misc (mods/streamer only)

`!coworksetgoal <number>`

changes the goal to the specified number

## Reset stuff (mods/streamer only)

`!coworkclearleaderboard`

clears out the user leaderboard, but leaves the overall task counts in place (in progress, completed, and the goal)

`!coworkclearstats`

clears out everything, for starting a fresh session

## Blocking

in case someone is causing a ruckus by just creating a ton of tasks or generally abusing the system. ideally won't ever need to be used since anyone causing a problem with the timer is probably just not a good fit for the chat, but the control is there if it needs to be used.

`!coworkblock <username>`

adds that user to the blocklist. if they try to use any of the bot commands, they'll just get ignored. no change in chat, it just dumps the command instead of acting on it.

`!coworkunblock <username>`

the reverse of the above, removes them from the blocklist so they can use the task commands again
