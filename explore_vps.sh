#!/usr/bin/expect

set timeout 20
set host "31.42.188.106"
set user "root"
set password "U:.Qw33teC8hS2"

spawn ssh $user@$host "ls -F"
expect "password:"
send "$password\r"
expect eof
