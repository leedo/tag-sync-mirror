###install node
<pre>
cd ~
wget http://nodejs.org/dist/v0.10.22/node-v0.10.22-linux-x64.tar.gz
tar -xvzf node-v0.10.22-linux-x64.tar.gz node
echo PATH=$HOME/node/bin:$PATH >> .bash_profile
source .bash_profile
</pre>

###checkout
<pre>
cd ~
git clone https://github.com/leedo/tag-sync-mirror.git
cd tag-sync-mirror
npm install supervisor formidable
mkdir -p data/tmp
cp config.example.json config.json
</pre>

Test that it launches with:

<pre>
node server.js
</pre>

You may need to modify the port number in `config.json`
if the default port (5000) is already in use.

###register

 * visit tracker
 * click "My servers"
 * enter a name
 * enter your server's address e.g. `http://123.45.6.7:5000`
 * click Submit

###update config

Note the server ID and token you were given in the last step.
Update your `config.json` file with those values.

###startup

<pre>
cd ~
cp ~/tag-sync-mirror/extra/dh-server.sh .
crontab -e
</pre>

This will bring up an editor. Enter this line:

<pre>
  * * * * *  bash $HOME/dh-server.sh start
</pre>

This will make sure your server is running every minute.
It will also start things with the proper `nice` level
that keeps your server from getting killed.
