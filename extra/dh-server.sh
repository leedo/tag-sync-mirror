#!/bin/bash

DIR="$HOME/tag-sync-mirror"
NODE="$HOME/node/bin/node"
SUPERVISOR="node_modules/.bin/supervisor"
SERVER="$DIR/server.js"
PID="$DIR/server.pid"
LOG="$DIR/server.log"

start_server()
{
  if [ $(running) == "down" ]
  then
    cd $DIR
    echo "staring server..."
    nice -n 19 -- $NODE $SUPERVISOR --exec $NODE server.js &> $LOG &
    echo "$!" > $PID
  fi
}

stop_server()
{
  if [ $(running) == "up" ]
  then
    p=$(cat $PID)
    echo "stopping server..."
    kill -TERM "$p"
    while kill -0 "$p"; do
      sleep 0.5
    done
  fi
  rm $PID
}

running()
{
  if [ -e "$PID" ]
  then
    proc=$(ps -p $(cat $PID) | grep -v 'PID' | awk '{print $4}')
    if [ $proc == "node" ]
    then
      echo "up"
    else
      echo "down"
    fi
  else
    echo "down"
  fi
}

case "$1" in
  "stop" )
    stop_server
    ;;
  "start" )
    start_server
    ;;
  "restart" )
    stop_server
    start_server
    ;;
  "status" )
    running
    ;;
  *)
    running
    ;;
esac
