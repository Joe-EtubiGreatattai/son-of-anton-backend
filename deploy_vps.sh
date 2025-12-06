#!/usr/bin/expect

set timeout 60
set host "31.42.188.106"
set user "root"
set password "U:.Qw33teC8hS2"

spawn ssh $user@$host
expect "password:"
send "$password\r"
expect "#"
send "cd son-of-anton-backend\r"
expect "#"
send "git pull\r"
expect "#"
send "npm install\r"
expect "#"
send "pm2 restart all\r"
expect "#"
send "exit\r"
expect eof
